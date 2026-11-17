import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
const bundled = await build({
  stdin: {
    contents:
      'export { DebugService } from "./src/core/debug-service.ts"; export { JobStore } from "./src/jobs/store.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { DebugService, JobStore } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
async function setup(t, storeFactory) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-debug-"));
  const solutionPath = path.join(root, "fixture.sln");
  await writeFile(solutionPath, "fixture");
  const owner = { sessionId: "session-" + root, cwd: root };
  const target = {
    instanceId: root,
    pid: 123,
    startTime: "vs-start",
    solutionPath,
  };
  const calls = [];
  let state = "break",
    failAction,
    startTime = "process-start",
    block,
    debuggeeStart = "debuggee";
  const bridge = {
    async request(action, params, signal) {
      signal?.throwIfAborted();
      calls.push({ action, params });
      if (action === "connect" || action === "status")
        return {
          target,
          state,
          debuggees: [{ processId: 9, startTime: debuggeeStart }],
        };
      if (action === "processDescribe")
        return { processId: params.processId, startTime };
      if (block?.action === action) {
        block.enter();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      if (action === failAction) throw new Error("response lost");
      if (action === "continue") state = "running";
      if (action === "pause") state = "break";
      if (action === "snapshot")
        return {
          state,
          stack: [{ function: state === "break" ? "fault" : "running" }],
        };
      return { accepted: true };
    },
    async close() {
      calls.push({ action: "close" });
    },
  };
  const store = storeFactory?.(root) ?? new JobStore(root + "-store");
  let workspace = root,
    callsLimit = 64;
  const service = new DebugService(
    store,
    () => bridge,
    async (expected) => {
      if (expected.cwd !== workspace) {
        const error = new Error("workspace changed");
        error.code = "OWNER_CHANGED";
        throw error;
      }
    },
    { get maxCalls() { return callsLimit; } },
  );
  t.after(() => service.dispose());
  await service.connect(owner, { instanceId: root, solutionPath });
  return {
    owner,
    service,
    calls,
    store,
    bridge,
    target,
    state: (s) => (state = s),
    fail: (a) => (failAction = a),
    processStart: (s) => (startTime = s),
    moveWorkspace: (cwd) => (workspace = cwd),
    callsLimit: (n) => (callsLimit = n),
    debuggeeStart: (s) => (debuggeeStart = s),
    block: (action) =>
      new Promise((resolve) => {
        block = { action, enter: resolve };
      }),
    begin: (p) =>
      service.begin(owner, {
        goal: "Find fault from observations",
        confirmed: true,
        ...p,
      }),
    perform: (i, requestId, action, params = {}, signal) =>
      service.perform(
        owner,
        { investigationId: i.investigationId, requestId, action, params },
        signal,
      ),
  };
}
test("dynamic feedback performs two independently chosen actions without preview", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  assert.equal(i.budget.maxCalls, 64);
  assert.equal(i.budget.timeoutMs, 600000);
  const first = await x.perform(i, "observe", "snapshot");
  assert.equal(first.actionResult.stack[0].function, "fault");
  x.state("running"); // Unlike a fixed preview, current observations are accepted.
  const second = await x.perform(i, "react", "pause");
  assert.equal(second.status, "succeeded");
  const view = await x.service.investigation(x.owner);
  assert.equal(view.actionsUsed, 2);
  assert.equal(view.lastJobId, second.jobId);
  assert.equal(view.history.length, 2);
  assert(!x.calls.some((c) => c.action === "preview"));
});
test("manual debuggee replacement is rejected without binding old debugger state", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  x.debuggeeStart("reused-pid");
  x.state("running");
  const r = await x.perform(i, "changed", "pause");
  assert.equal(r.error.code, "TARGET_CHANGED");
  assert(!x.calls.some((c) => c.action === "pause"));
});
test("risk scope cannot be escalated per action and legacy cannot bypass it", async (t) => {
  const x = await setup(t);
  const old = await x.service.preview(x.owner, {
    steps: [{ action: "terminate" }],
    allowTerminate: true,
  });
  const i = await x.begin();
  for (const [action, params] of [
    ["evaluate", { expression: "f()" }],
    ["terminate", {}],
    ["attach", { processId: 9 }],
  ])
    await assert.rejects(x.perform(i, action, action, params), {
      code: "RISK_NOT_AUTHORIZED",
    });
  await assert.rejects(
    x.service.preview(x.owner, { steps: [{ action: "snapshot" }] }),
    { code: "DYNAMIC_SESSION" },
  );
  await assert.rejects(
    x.service.execute(x.owner, { previewId: old.previewId, confirmed: true }),
    { code: "DYNAMIC_SESSION" },
  );
  assert.equal((await x.service.investigation(x.owner)).actionsUsed, 0);
});
test("attach freezes PID and start identity at begin", async (t) => {
  const x = await setup(t);
  await assert.rejects(x.begin({ allowAttach: true }), {
    code: "INVALID_INPUT",
  });
  const i = await x.begin({ allowAttach: true, processId: 9 });
  await assert.rejects(x.perform(i, "wrong-pid", "attach", { processId: 10 }), {
    code: "RISK_NOT_AUTHORIZED",
  });
  x.processStart("reused");
  const r = await x.perform(i, "reused", "attach", { processId: 9 });
  assert.equal(r.error.code, "TARGET_CHANGED");
  assert(!x.calls.some((c) => c.action === "attach"));
});
test("request ids deduplicate results without budget and reject conflicts", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  const a = await x.perform(i, "one", "snapshot"),
    b = await x.perform(i, "one", "snapshot");
  assert.equal(a.jobId, b.jobId);
  assert.equal(x.calls.filter((c) => c.action === "snapshot").length, 1);
  assert.equal((await x.service.investigation(x.owner)).actionsUsed, 1);
  await assert.rejects(x.perform(i, "one", "continue"), {
    code: "REQUEST_CONFLICT",
  });
});
test("unknown action never replays, blocks new begin and keeps safe snapshot", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  x.fail("continue");
  const a = await x.perform(i, "unknown", "continue");
  assert.equal(a.status, "unknown");
  assert.equal((await x.perform(i, "unknown", "continue")).jobId, a.jobId);
  await assert.rejects(x.perform(i, "fresh", "continue"), {
    code: "AUTHORIZATION_REVOKED",
  });
  await assert.rejects(x.begin(), { code: "RECONNECT_REQUIRED" });
  assert.equal((await x.service.snapshot(x.owner)).state, "break");
  assert.equal(x.calls.filter((c) => c.action === "continue").length, 1);
});
test("session and cwd ownership enforced, takeover works across cwd and is immediate", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  await assert.rejects(
    x.service.perform(
      { ...x.owner, sessionId: "foreign" },
      {
        investigationId: i.investigationId,
        requestId: "a",
        action: "continue",
      },
    ),
    { code: "FOREIGN_INVESTIGATION" },
  );
  await assert.rejects(
    x.service.perform(
      { ...x.owner, cwd: os.tmpdir() },
      {
        investigationId: i.investigationId,
        requestId: "b",
        action: "continue",
      },
    ),
    { code: "FOREIGN_INVESTIGATION" },
  );
  const entered = x.block("snapshot"),
    pending = x.perform(i, "blocking", "snapshot");
  await entered;
  await assert.rejects(x.perform(i, "busy", "snapshot"), { code: "BUSY" });
  const v = await x.service.takeover({ ...x.owner, cwd: os.tmpdir() });
  assert.equal(v.authorized, false);
  assert.equal(v.status, "revoked");
  assert.equal((await pending).status, "cancelled");
  await assert.rejects(x.perform(i, "later", "pause"), {
    code: "AUTHORIZATION_REVOKED",
  });
  assert(
    !x.calls.some((c) => ["pause", "terminate", "detach"].includes(c.action)),
  );
});
test("abort signal cancels automation only and retains observation", async (t) => {
  const x = await setup(t),
    i = await x.begin(),
    controller = new AbortController();
  const entered = x.block("snapshot"),
    pending = x.perform(i, "cancel", "snapshot", {}, controller.signal);
  await entered;
  controller.abort();
  assert.equal((await pending).status, "cancelled");
  assert(!x.calls.some((c) => ["pause", "terminate"].includes(c.action)));
});
test("budget accumulates across perform and begin cannot reset session window", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  for (let n = 0; n < 64; n++)
    assert.equal(
      (await x.perform(i, "call-" + n, "snapshot")).status,
      "succeeded",
    );
  await assert.rejects(x.perform(i, "excess", "snapshot"), {
    code: "BUDGET_EXCEEDED",
  });
  assert.equal((await x.perform(i, "call-0", "snapshot")).status, "succeeded");
  await x.service.takeover(x.owner);
  await assert.rejects(x.begin(), { code: "BUDGET_EXCEEDED" });
});
test("takeover during begin observation invalidates pending authorization epoch", async (t) => {
  const x = await setup(t);
  const request = x.bridge.request.bind(x.bridge);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  x.bridge.request = async (action, params, signal) => {
    if (action === "status") {
      enter();
      await gate;
    }
    return request(action, params, signal);
  };
  const pending = x.begin();
  await entered;
  const view = await x.service.takeover({ ...x.owner, cwd: os.tmpdir() });
  assert.equal(view.authorized, false);
  release();
  await assert.rejects(pending, { code: "AUTHORIZATION_REVOKED" });
  assert.equal((await x.service.investigation(x.owner)).status, "idle");
  assert(
    !x.calls.some((c) =>
      ["continue", "pause", "terminate", "attach"].includes(c.action),
    ),
  );
});
test("takeover during begin persistence revokes the newly inserted investigation", async (t) => {
  const x = await setup(t),
    save = x.store.save.bind(x.store);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  x.store.save = async (record) => {
    enter();
    await gate;
    return save(record);
  };
  const pending = x.begin();
  await entered;
  assert.equal((await x.service.takeover(x.owner)).status, "revoked");
  release();
  await assert.rejects(pending, { code: "AUTHORIZATION_REVOKED" });
  const view = await x.service.investigation(x.owner);
  assert.equal(view.authorized, false);
  await assert.rejects(x.perform(view, "race", "continue"), {
    code: "AUTHORIZATION_REVOKED",
  });
});
test("rejected request ids remain reusable and retention fails closed", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  await assert.rejects(x.perform(i, "bad", "evaluate", { expression: "f()" }), {
    code: "RISK_NOT_AUTHORIZED",
  });
  await assert.rejects(x.perform(i, "bad", "evaluate", { expression: "f()" }), {
    code: "RISK_NOT_AUTHORIZED",
  });
  const observed = await x.perform(i, "bad", "snapshot");
  assert.equal(observed.status, "succeeded");
  x.callsLimit(1025);
  for (let n = 0; n < 1023; n++)
    assert.equal((await x.perform(i, "slot-" + n, "snapshot")).status, "succeeded");
  await assert.rejects(x.perform(i, "overflow", "snapshot"), {
    code: "CAPACITY",
  });
});

test("revoked investigations do not permanently exhaust global capacity", async (t) => {
  const x = await setup(t);
  for (let n = 0; n < 128; n++) {
    await x.begin();
    await x.service.takeover(x.owner);
  }
  const next = await x.begin();
  assert.equal(next.status, "active");
});

test("workspace change revokes further begin and perform without stopping debuggee", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  x.moveWorkspace(os.tmpdir());
  await assert.rejects(x.perform(i, "moved", "continue"), {
    code: "OWNER_CHANGED",
  });
  await assert.rejects(x.begin(), { code: "OWNER_CHANGED" });
  assert(!x.calls.some((c) => ["continue", "pause", "terminate"].includes(c.action)));
});

test("deadline expires authorization and disconnect revokes existing investigation", async (t) => {
  const x = await setup(t),
    i = await x.begin();
  const now = Date.now;
  try {
    Date.now = () => i.budget.expiresAt + 1;
    await assert.rejects(x.perform(i, "expired", "continue"), {
      code: "BUDGET_EXCEEDED",
    });
    assert.equal((await x.service.investigation(x.owner)).authorized, false);
  } finally {
    Date.now = now;
  }
  await x.service.disconnect(x.owner);
  await assert.rejects(x.perform(i, "disconnected", "continue"), {
    code: "AUTHORIZATION_REVOKED",
  });
  assert(!x.calls.some((c) => c.action === "continue"));
});
test("persisted investigation and results are observable but restart never restores consent", async (t) => {
  const x = await setup(t),
    i = await x.begin(),
    job = await x.perform(i, "saved", "snapshot");
  await x.service.dispose();
  const next = new DebugService(x.store, () => x.bridge);
  t.after(() => next.dispose());
  const v = await next.investigation(x.owner, {
    investigationId: i.investigationId,
  });
  assert.equal(v.authorized, false);
  assert.equal(v.lastJobId, job.jobId);
  assert.equal(
    (await next.jobStatus(x.owner, { jobId: job.jobId })).investigationId,
    i.investigationId,
  );
  await assert.rejects(
    next.perform(x.owner, {
      investigationId: i.investigationId,
      requestId: "saved",
      action: "snapshot",
    }),
    { code: "AUTHORIZATION_REVOKED" },
  );
  await assert.rejects(
    next.investigation(
      { ...x.owner, sessionId: "foreign" },
      { investigationId: i.investigationId },
    ),
  );
});
test("begin rejects unconfirmed and client budgets; persistence fails closed", async (t) => {
  const x = await setup(t);
  await assert.rejects(
    x.service.begin(x.owner, { goal: "debug", confirmed: false }),
    { code: "CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(x.begin({ maxCalls: 999 }), { code: "INVALID_INPUT" });
  const i = await x.begin();
  x.store.save = async () => {
    throw Error("disk full");
  };
  const failed = await x.perform(i, "disk-full", "continue");
  assert.equal(failed.status, "persistence_failed");
  assert.equal(failed.outcome, "not_started");
  assert.equal(
    (await x.service.jobStatus(x.owner, { jobId: failed.jobId })).status,
    "persistence_failed",
  );
  assert.equal(
    (await x.service.investigation(x.owner)).history[0].status,
    "persistence_failed",
  );
  assert.equal(
    (await x.perform(i, "disk-full", "continue")).jobId,
    failed.jobId,
  );
  assert(!x.calls.some((c) => c.action === "continue"));
  await assert.rejects(x.perform(i, "fresh", "continue"), {
    code: "AUTHORIZATION_REVOKED",
  });
});
