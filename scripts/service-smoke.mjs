import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixturePath, processIdentity, OwnedProcessLedger } from "../bridge/smoke-helpers.mjs";
import path from "node:path";
if (process.env.DSH_AUTO_DEBUG_NEW_FIXTURE !== "1") throw Error("Explicit DSH_AUTO_DEBUG_NEW_FIXTURE=1 required");
const vs = process.env.DSH_AUTO_DEBUG_VS_EXE;
if (!vs) throw Error("Explicit Visual Studio executable required");
const solution = await fixturePath(process.env.DSH_AUTO_DEBUG_FIXTURE_SOLUTION ?? "test/fixtures/cpp/build/DshDebugFixture.sln");
let child, ledger, failure;
try {
  child = spawn(vs, [solution, "/NoSplash"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const root = await processIdentity(child.pid);
  ledger = new OwnedProcessLedger(root, true); await ledger.initialize();
  // Reuse the exact-identity integration runner against this newly-created fixture.
  // No second VS is created. Discovery here never controls an unrelated instance.
  const { DebugService, JobStore } = await import("../dist/plugin.js");
  const discovery = new DebugService(new JobStore(path.resolve(".artifacts/service-discovery")));
  let target;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await ledger.capture();
      target = (await discovery.discover()).instances.find(x => x.pid === root.pid && x.startTime === root.startTime && path.resolve(x.solutionPath).toLowerCase() === solution.toLowerCase());
      if (target) break;
      await delay(750);
    }
  } finally { await discovery.dispose(); }
  if (!target) throw Error("Dedicated exact fixture VS did not become available");
  process.env.DSH_AUTO_DEBUG_INTEGRATION = "1";
  process.env.DSH_AUTO_DEBUG_VS_INSTANCE = target.instanceId;
  process.env.DSH_AUTO_DEBUG_SOLUTION = solution;
  process.env.DSH_AUTO_DEBUG_SOURCE ??= await fixturePath("test/fixtures/cpp/main.cpp");
  await import("./integration.mjs");
} catch (e) { failure = e; }
finally {
  const errors = failure ? [failure] : [];
  if (ledger) try { await ledger.cleanup(); } catch (e) { errors.push(e); }
  else if (child?.pid) errors.push(Error("VS started but creation identity unavailable; manual exact-PID cleanup required: " + child.pid));
  if (errors.length) throw new AggregateError(errors, "Service smoke or cleanup failed; NOT PASS");
}
console.log("PASS service smoke and exact owned VS cleanup");
