import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DebugService, JobStore } from "../dist/plugin.js";
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "identity-test-"));
  const solutionPath = path.join(cwd, "fixture.sln");
  await writeFile(solutionPath, "fixture");
  const owner = { sessionId: cwd, cwd },
    target = { instanceId: cwd, pid: 3, startTime: "one", solutionPath };
  let debuggees = [{ processId: 1, startTime: "original" }];
  const calls = [];
  const bridge = {
    async request(action, params) {
      calls.push({ action, params });
      if (action === "connect" || action === "status")
        return {
          target,
          state: "break",
          debuggees: structuredClone(debuggees),
        };
      if (action === "processDescribe")
        return { processId: params.processId, startTime: "fixed-start" };
      return { accepted: true };
    },
    async close() {},
  };
  const service = new DebugService(new JobStore(cwd + "-store"), () => bridge);
  t.after(() => service.dispose());
  await service.connect(owner, { instanceId: cwd, solutionPath });
  return {
    service,
    owner,
    calls,
    replace: () => (debuggees = [{ processId: 1, startTime: "replacement" }]),
  };
}
test("attach preview freezes process start identity and cannot be mutated through returned object", async (t) => {
  const x = await fixture(t);
  const p = await x.service.preview(x.owner, {
    steps: [{ action: "attach", params: { processId: 99 } }],
  });
  assert.equal(p.steps[0].params.expectedStartTime, "fixed-start");
  p.steps[0].params.expectedStartTime = "tamper";
  p.steps[0].action = "terminate";
  const result = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(result.status, "succeeded");
  const attach = x.calls.find((c) => c.action === "attach");
  assert(attach);
  assert.equal(attach.params.expectedStartTime, "fixed-start");
});
test("debuggee replacement after preview rejects old plan before sending control", async (t) => {
  const x = await fixture(t);
  const p = await x.service.preview(x.owner, {
    steps: [{ action: "continue", params: {} }],
  });
  x.replace();
  const result = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "TARGET_CHANGED");
  assert(!x.calls.some((c) => c.action === "continue"));
});
