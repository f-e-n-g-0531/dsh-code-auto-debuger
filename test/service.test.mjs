import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DebugService, JobStore, apply } from "../dist/plugin.js";
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-debug-test-"));
  const solution = path.join(root, "test.sln");
  await writeFile(solution, "fixture");
  const owner = { sessionId: "a", cwd: root };
  const target = {
    instanceId: "fixture:" + root,
    pid: 123,
    startTime: "1",
    solutionPath: solution,
  };
  const calls = [];
  let state = "break";
  let busyReads = 0;
  let failAction = "";
  const bridge = {
    async request(method, params, signal) {
      signal?.throwIfAborted();
      calls.push(method);
      if (method === "status" && busyReads-- > 0)
        throw Object.assign(new Error("busy"), { code: "BUSY" });
      if (method === failAction) throw Error("lost response");
      if (method === "connect" || method === "status") return { target, state };
      if (method === "processDescribe")
        return { processId: params.processId, startTime: "preview-start" };
      if (method === "continue") state = "running";
      if (method === "snapshot")
        return {
          target,
          state,
          stack: [{ function: "main" }],
          stopId: "observation",
        };
      return { accepted: true };
    },
    async close() {
      calls.push("close");
    },
  };
  const service = new DebugService(new JobStore(root + "-store"), () => bridge);
  t.after(() => service.dispose());
  await service.connect(owner, {
    instanceId: target.instanceId,
    solutionPath: solution,
  });
  return {
    root,
    solution,
    owner,
    target,
    calls,
    service,
    bridge,
    setState: (v) => (state = v),
    failAction: (v) => (failAction = v),
    busyReads: (v) => {
      busyReads = v;
    },
  };
}
const step = (action, params = {}) => ({ action, params });
test("preview does not dispatch mutations; execute consumes it exactly once", async (t) => {
  const x = await setup(t);
  const p = await x.service.preview(x.owner, { steps: [step("continue")] });
  assert(!x.calls.includes("continue"));
  const r = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(r.status, "succeeded");
  assert.equal(x.calls.filter((v) => v === "continue").length, 1);
  await assert.rejects(
    x.service.execute(x.owner, { previewId: p.previewId, confirmed: true }),
    { code: "PREVIEW_EXPIRED" },
  );
});
test("confirmation and owner are checked", async (t) => {
  const x = await setup(t);
  const p = await x.service.preview(x.owner, { steps: [step("snapshot")] });
  await assert.rejects(
    x.service.execute(x.owner, { previewId: p.previewId, confirmed: false }),
    { code: "CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    x.service.execute(
      { ...x.owner, sessionId: "b" },
      { previewId: p.previewId, confirmed: true },
    ),
    { code: "PREVIEW_EXPIRED" },
  );
});
test("evaluation and termination require risk switches", async (t) => {
  const x = await setup(t);
  for (const s of [
    step("evaluate", { expression: "danger()" }),
    step("terminate"),
  ])
    await assert.rejects(x.service.preview(x.owner, { steps: [s] }), {
      code: "RISK_NOT_AUTHORIZED",
    });
});
test("invalid plan fields budgets actions and paths rejected", async (t) => {
  const x = await setup(t);
  for (const raw of [
    { steps: [] },
    { steps: [step("shell")] },
    { steps: [step("snapshot", { extra: 1 })] },
    { steps: [step("snapshot")], maxSteps: 0 },
    { steps: [step("snapshot")], timeoutMs: 300001 },
    { steps: [step("step", { kind: "bad" })] },
    { steps: [step("attach", { processId: -1 })] },
  ])
    await assert.rejects(x.service.preview(x.owner, raw));
  const outside = path.join(os.tmpdir(), "outside-" + Date.now() + ".cpp");
  await writeFile(outside, "x");
  await assert.rejects(
    x.service.preview(x.owner, {
      steps: [step("breakpointAdd", { file: outside, line: 1 })],
    }),
    { code: "OUTSIDE_WORKSPACE" },
  );
});
test("target changed after preview prevents mutations", async (t) => {
  const x = await setup(t);
  const p = await x.service.preview(x.owner, { steps: [step("continue")] });
  x.target.startTime = "2";
  const r = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "TARGET_CHANGED");
  assert(!x.calls.includes("continue"));
});
test("lost mutation outcome is unknown, no automatic replay", async (t) => {
  const x = await setup(t);
  x.failAction("continue");
  const p = await x.service.preview(x.owner, {
    steps: [step("continue"), step("snapshot")],
  });
  const r = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(r.status, "unknown");
  assert.equal(r.results.length, 0);
  assert.equal(x.calls.filter((v) => v === "continue").length, 1);
  assert.equal(
    (await x.service.jobStatus(x.owner, { jobId: r.jobId })).status,
    "unknown",
  );
  await assert.rejects(
    x.service.preview(x.owner, { steps: [step("continue")] }),
    { code: "RECONNECT_REQUIRED" },
  );
  await assert.rejects(
    x.service.jobStatus({ ...x.owner, sessionId: "other" }, { jobId: r.jobId }),
    { code: "FOREIGN_JOB" },
  );
});
test("async UI task cancellation stops subsequent operations without terminate", async (t) => {
  const x = await setup(t);
  x.setState("running");
  const p = await x.service.preview(x.owner, {
    steps: [step("waitForBreak", { timeoutMs: 2000 }), step("continue")],
    timeoutMs: 3000,
  });
  const r = await x.service.execute(
    x.owner,
    { previewId: p.previewId, confirmed: true },
    undefined,
    false,
  );
  assert.equal(r.status, "queued");
  await assert.rejects(x.service.status(x.owner), { code: "BUSY" });
  const end = await x.service.cancel(x.owner, { jobId: r.jobId });
  assert.equal(end.status, "cancelled");
  assert(!x.calls.includes("continue"));
  assert(!x.calls.includes("terminate"));
});
test("cross-service same instance exclusion", async (t) => {
  const x = await setup(t);
  const other = new DebugService(
    new JobStore(path.join(x.root, "store2")),
    () => x.bridge,
  );
  t.after(() => other.dispose());
  await assert.rejects(
    other.connect(
      { ...x.owner, sessionId: "other" },
      { instanceId: x.target.instanceId, solutionPath: x.solution },
    ),
    { code: "TARGET_BUSY" },
  );
});
test("interrupted on-disk job is not resumed or replayed", async (t) => {
  const x = await setup(t);
  const store = new JobStore(x.root + "-recover");
  const jobId = "00000000-0000-4000-8000-000000000001";
  await store.save({
    jobId,
    owner: x.owner,
    status: "running",
    steps: [],
    results: [],
    target: x.target,
  });
  const r = await store.read(jobId, x.owner);
  assert.equal(r.status, "interrupted");
  assert.equal(r.externalState, "unknown");
});
test("host registers tools and RPC with owner scope; dispose is registered", async () => {
  const defs = [],
    events = [];
  let rpc;
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-debug-host-"));
  const ctx = {
    tools: { register: (d) => defs.push(d) },
    connection: {
      register: (owner, channel, fn) => {
        assert.equal(owner, ctx);
        assert.match(channel, /^\/auto-debug(?:-profiler)?-rpc$/);
        if (channel === "/auto-debug-rpc") rpc = fn;
      },
    },
    sessions: {
      get: (id) => (id === "a" ? { header: { id, cwd: root } } : undefined),
    },
    sessionPersistence: { stat: async () => undefined },
    on: (event, fn) => events.push(fn),
  };
  apply(ctx);
  assert.equal(defs.length, 16);
  assert(defs.every((d) => d.output?.render));
  const caps = await defs[0].execute({}, { agent: { session: { id: "a" } } });
  assert.equal(caps.protocol, 1);
  const denied = await rpc("capabilities", { sessionId: "missing" });
  assert.equal(denied.ok, false);
  const invalid = await rpc("launch", { sessionId: "a" });
  assert.equal(invalid.error.code, "UNKNOWN_ACTION");
  await events[0]();
});
test("same owner concurrent connect rejected and dispose waits pending connection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connect-race-"));
  const solution = path.join(root, "test.sln");
  await writeFile(solution, "fixture");
  let release;
  const gate = new Promise((r) => (release = r));
  let started;
  const start = new Promise((r) => (started = r));
  let closes = 0;
  const owner = { sessionId: "race", cwd: root };
  const target = {
    instanceId: "race:" + root,
    pid: 1,
    startTime: "1",
    solutionPath: solution,
  };
  const service = new DebugService(new JobStore(root + "-jobs"), () => ({
    async request() {
      started();
      await gate;
      return { target, state: "design" };
    },
    async close() {
      closes++;
    },
  }));
  const pending = service.connect(owner, {
    instanceId: target.instanceId,
    solutionPath: solution,
  });
  await start;
  await assert.rejects(
    service.connect(owner, { instanceId: "other", solutionPath: solution }),
    { code: "ALREADY_CONNECTED" },
  );
  const disposed = service.dispose();
  release();
  await assert.rejects(pending, { code: "CLOSED" });
  await disposed;
  assert.equal(closes, 1);
});
test("busy status retries only reads and never repeats a mutation", async (t) => {
  const x = await setup(t);
  x.busyReads(2);
  const p = await x.service.preview(x.owner, { steps: [step("continue")] });
  assert.equal(x.calls.filter((c) => c === "continue").length, 0);
  const r = await x.service.execute(x.owner, {
    previewId: p.previewId,
    confirmed: true,
  });
  assert.equal(r.status, "succeeded");
  assert.equal(x.calls.filter((c) => c === "continue").length, 1);
});
test("store inside workspace is rejected before creating files", async (t) => {
  const x = await setup(t);
  const store = new JobStore(path.join(x.root, "unsafe"));
  await assert.rejects(
    store.save({
      jobId: "00000000-0000-4000-8000-000000000002",
      owner: x.owner,
      status: "queued",
    }),
    { code: "UNSAFE_STORE" },
  );
});
