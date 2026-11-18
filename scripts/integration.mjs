import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DebugService, JobStore } from "../dist/plugin.js";
import {
  fixturePath,
  markerLine,
  assertBreakpointHit,
  assertAdvancement,
  processIdentity,
  OwnedProcessLedger,
} from "../bridge/smoke-helpers.mjs";
import { pathToFileURL } from "node:url";
import { reportIntegration } from "./integration-report.mjs";

export async function runIntegration({ directory }) {
  if (process.env.DSH_AUTO_DEBUG_INTEGRATION !== "1")
    throw Error(
      "Real VS test not authorized: set DSH_AUTO_DEBUG_INTEGRATION=1",
    );
  const instanceId = process.env.DSH_AUTO_DEBUG_VS_INSTANCE;
  if (
    !instanceId ||
    !process.env.DSH_AUTO_DEBUG_SOLUTION ||
    !process.env.DSH_AUTO_DEBUG_SOURCE
  )
    throw Error(
      "Explicit fixture VS instance, solution and source required; NOT PASS",
    );
  const solutionPath = await fixturePath(process.env.DSH_AUTO_DEBUG_SOLUTION);
  const source = await fixturePath(process.env.DSH_AUTO_DEBUG_SOURCE);
  const line = process.env.DSH_AUTO_DEBUG_LINE
    ? Number(process.env.DSH_AUTO_DEBUG_LINE)
    : await markerLine(
        source,
        process.env.DSH_AUTO_DEBUG_MARKER ?? "BREAKPOINT:",
      );
  if (!Number.isSafeInteger(line) || line < 1)
    throw Error("Invalid source line");
  const owner = {
    sessionId: "integration",
    cwd: await realpath("test/fixtures"),
  };
  let service, ledger, failure, evidence;
  try {
    await mkdir(".artifacts", { recursive: true });
    service = new DebugService(new JobStore(path.resolve(directory, "jobs")));
    const discovery = await service.discover();
    const target = discovery.instances.find(
      (x) =>
        x.instanceId === instanceId &&
        path.resolve(x.solutionPath).toLowerCase() ===
          solutionPath.toLowerCase(),
    );
    if (!target) throw Error("Exact fixture VS identity not discovered");
    const root = await processIdentity(target.pid);
    if (root.startTime !== target.startTime)
      throw Error("VS creation identity mismatch");
    ledger = new OwnedProcessLedger(root);
    await ledger.initialize();
    await service.connect(owner, { instanceId, solutionPath });
    if ((await service.status(owner)).state !== "design")
      throw Error("Fixture VS must begin in design mode");
    async function execute(steps) {
      const plan = await service.preview(owner, {
        steps,
        timeoutMs: 30000,
        maxSteps: 8,
      });
      // Preview and execute each mutation once; failures are never retried.
      const result = await service.execute(owner, {
        previewId: plan.previewId,
        confirmed: true,
      });
      await ledger.capture();
      if (result.status !== "succeeded")
        throw Error(JSON.stringify(result.error));
      return result;
    }
    const result = await execute([
      { action: "breakpointAdd", params: { file: source, line } },
      { action: "launch", params: {} },
      { action: "waitForBreak", params: { timeoutMs: 20000 } },
      { action: "snapshot", params: {} },
    ]);
    const bp = result.results[0]?.value;
    if (!bp?.created || !bp.breakpointId)
      throw Error("New breakpoint identity missing; inspect before retry");
    const before = result.results.at(-1)?.value;
    assertBreakpointHit(
      before,
      source,
      line,
      process.env.DSH_AUTO_DEBUG_EXPECTED_FUNCTION ?? "Add",
    );
    const stepped = await execute([
      { action: "step", params: { kind: "over" } },
      { action: "waitForBreak", params: { timeoutMs: 20000 } },
      { action: "snapshot", params: {} },
    ]);
    assertAdvancement(before, stepped.results.at(-1)?.value);
    const removed = await execute([
      { action: "breakpointRemove", params: { breakpointId: bp.breakpointId } },
    ]);
    const remaining = await service.ownedBreakpoints(owner);
    if (remaining.breakpoints.some((x) => x.breakpointId === bp.breakpointId))
      throw Error("Deletion postquery failed");
    evidence = { result, stepped, removed, remaining };
  } catch (e) {
    failure = e;
  } finally {
    const errors = failure ? [failure] : [];
    if (ledger)
      try {
        await ledger.cleanup();
      } catch (e) {
        errors.push(e);
      }
    if (service)
      try {
        await service.dispose();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Integration or cleanup failed; NOT PASS",
      );
  }
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await reportIntegration("existing-fixture-vs", runIntegration);
  console.log(
    "PASS exact fixture breakpoint/function, step advancement, deletion postquery and owned child cleanup; pre-existing VS retained",
  );
}
