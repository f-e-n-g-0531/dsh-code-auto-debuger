import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";

// Compile only the owned service into memory; never replace shared dist artifacts.
const compiled = await build({
  stdin: {
    contents:
      'export {DebugService} from "./src/core/debug-service.ts"; export {JobStore} from "./src/jobs/store.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { DebugService, JobStore } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const step = (action) => ({ action, params: {} });
async function fixture(t, { failSave, onAction, authorize } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "core-recovery-"));
  const solutionPath = path.join(root, "fixture.sln");
  await writeFile(solutionPath, "fixture");
  const owner = { sessionId: randomUUID(), cwd: root };
  const target = {
    instanceId: randomUUID(),
    pid: 42,
    startTime: "fixture",
    solutionPath,
  };
  const calls = [];
  const store = new JobStore(root + "-store");
  const save = store.save.bind(store);
  let saves = 0;
  store.save = async (job) => {
    if (failSave?.(job, ++saves))
      throw Object.assign(Error("injected disk error"), { code: "EIO" });
    return save(job);
  };
  const bridge = {
    async request(method, params, signal) {
      signal?.throwIfAborted();
      calls.push(method);
      if (method === "status" || method === "connect")
        return { target, state: "break" };
      await onAction?.(method, signal);
      return { accepted: true };
    },
    async close() {
      calls.push("close");
    },
  };
  const service = new DebugService(store, () => bridge, authorize);
  t.after(() => service.dispose());
  await service.connect(owner, { instanceId: target.instanceId, solutionPath });
  return { service, store, owner, target, root, calls };
}
async function execute(x, steps = [step("snapshot")], extra = {}, wait = true) {
  const preview = await x.service.preview(x.owner, { steps });
  const args = { previewId: preview.previewId, confirmed: true, ...extra };
  return { job: await x.service.execute(x.owner, args, undefined, wait), args };
}

test("terminal-save failure is observable in memory and locks connection; never replays", async (t) => {
  const x = await fixture(t, { failSave: (job) => job.status === "succeeded" });
  const { job, args } = await execute(x, [step("continue")], {
    requestId: "lost-response",
  });
  assert.equal(job.status, "persistence_failed");
  assert.equal(job.outcome, "succeeded");
  assert.equal(job.persistence.status, "failed");
  assert.equal(
    (await x.service.jobStatus(x.owner, { jobId: job.jobId })).status,
    "persistence_failed",
  );
  assert.equal((await x.service.execute(x.owner, args)).jobId, job.jobId);
  assert.equal(x.calls.filter((x) => x === "continue").length, 1);
  await assert.rejects(
    x.service.preview(x.owner, { steps: [step("snapshot")] }),
    { code: "RECONNECT_REQUIRED" },
  );
  const listed = await x.service.listJobs(x.owner, {
    requestId: "lost-response",
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.jobs[0].status, "persistence_failed");
  assert.equal((await x.store.read(job.jobId, x.owner)).status, "interrupted");
});

test("initial/intermediate save failures dispatch no subsequent operation and stay explicit", async (t) => {
  for (const failAt of [1, 2, 3]) {
    const x = await fixture(t, { failSave: (_, count) => count === failAt });
    const { job } = await execute(x, [step("snapshot"), step("continue")]);
    assert.equal(job.status, "persistence_failed");
    assert.equal(job.persistence.status, "failed");
    assert(!x.calls.includes("continue"));
    assert.equal(
      (await x.service.cancel(x.owner, { jobId: job.jobId })).status,
      "persistence_failed",
    );
  }
});

test("async terminal failure remains recoverable without an unhandled rejection", async (t) => {
  const x = await fixture(t, { failSave: (job) => job.status === "succeeded" });
  const { job } = await execute(x, [step("snapshot")], {}, false);
  // cancel waits for the owned lifetime rather than polling or sleeping.
  const result = await x.service.cancel(x.owner, { jobId: job.jobId });
  assert(["cancelled", "persistence_failed"].includes(result.status));
  assert.equal((await x.service.currentJob(x.owner)).jobId, job.jobId);
});

test("cwd change stops subsequent steps; same session recovers/cancels old cwd, others rejected", async (t) => {
  let changed = false;
  const x = await fixture(t, {
    authorize: async () => {
      if (changed)
        throw Object.assign(Error("workspace changed"), {
          code: "WORKSPACE_CHANGED",
        });
    },
    onAction: async (method) => {
      if (method === "snapshot") changed = true;
    },
  });
  const { job } = await execute(x, [step("snapshot"), step("continue")]);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "WORKSPACE_CHANGED");
  assert(!x.calls.includes("continue"));
  const moved = { ...x.owner, cwd: tmpdir() };
  assert.equal(
    (await x.service.jobStatus(moved, { jobId: job.jobId })).jobId,
    job.jobId,
  );
  assert.equal(
    (await x.service.cancel(moved, { jobId: job.jobId })).jobId,
    job.jobId,
  );
  assert.equal((await x.store.read(job.jobId, moved)).jobId, job.jobId);
  await assert.rejects(
    x.service.jobStatus(
      { ...moved, sessionId: "foreign" },
      { jobId: job.jobId },
    ),
    { code: "FOREIGN_JOB" },
  );
  await assert.rejects(
    x.service.cancel({ ...moved, sessionId: "foreign" }, { jobId: job.jobId }),
    { code: "FOREIGN_JOB" },
  );
  assert.equal(
    (await x.service.listJobs({ ...moved, sessionId: "foreign" })).total,
    0,
  );
  await x.service.disconnect(moved);
});

test("requestId recovers response loss including concurrent duplicates and restart without execution", async (t) => {
  const x = await fixture(t);
  const preview = await x.service.preview(x.owner, {
    steps: [step("continue")],
  });
  const args = {
    previewId: preview.previewId,
    confirmed: true,
    requestId: "once",
  };
  const [a, b] = await Promise.all([
    x.service.execute(x.owner, args),
    x.service.execute(x.owner, args),
  ]);
  assert.equal(a.jobId, b.jobId);
  assert.equal(x.calls.filter((x) => x === "continue").length, 1);
  await assert.rejects(
    x.service.execute(x.owner, { ...args, previewId: randomUUID() }),
    { code: "REQUEST_CONFLICT" },
  );
  const restarted = new DebugService(x.store, () => {
    throw Error("must not connect");
  });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.execute(x.owner, args)).jobId, a.jobId);
  assert.equal(
    (await restarted.listJobs(x.owner, { requestId: "once", limit: 1 })).total,
    1,
  );
});

test("safe store listing rejects malformed/external JSON and validates pagination", async (t) => {
  const x = await fixture(t);
  const { job } = await execute(x);
  const scoped = path.join(
    x.root + "-store",
    createHash("sha256").update(x.owner.sessionId).digest("hex"),
  );
  await writeFile(path.join(scoped, randomUUID() + ".json"), '{"owner":null}');
  await writeFile(path.join(scoped, randomUUID() + ".json"), "{ invalid");
  const foreignId = randomUUID();
  await writeFile(
    path.join(scoped, foreignId + ".json"),
    JSON.stringify({
      ...job,
      jobId: foreignId,
      owner: { ...x.owner, sessionId: "foreign" },
    }),
  );
  await writeFile(
    path.join(x.root + "-store", randomUUID() + ".json"),
    "{ malicious outside namespace",
  );
  const listing = await x.service.listJobs(x.owner);
  assert.equal(listing.total, 1);
  await assert.rejects(x.service.listJobs(x.owner, { limit: 101 }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(x.service.listJobs(x.owner, { offset: -1 }), {
    code: "INVALID_INPUT",
  });
  assert((await readdir(scoped)).every((name) => !name.endsWith(".tmp")));
});

test("same-session moved owner can cancel an active old-cwd task", async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const x = await fixture(t, {
    onAction: async (method, signal) => {
      if (method !== "snapshot") return;
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal.aborted) reject(signal.reason);
      });
    },
  });
  const { job } = await execute(
    x,
    [step("snapshot"), step("continue")],
    {},
    false,
  );
  await entered;
  const moved = { ...x.owner, cwd: tmpdir() };
  await assert.rejects(
    x.service.cancel({ ...moved, sessionId: "foreign" }, { jobId: job.jobId }),
    { code: "FOREIGN_JOB" },
  );
  const result = await x.service.cancel(moved, { jobId: job.jobId });
  assert.equal(result.status, "cancelled");
  assert(!x.calls.includes("continue"));
});

test("legacy UUID and bounded listing recover own session and reject foreign records", async (t) => {
  const x = await fixture(t);
  const id = randomUUID();
  const root = x.root + "-store";
  await x.service.listJobs(x.owner);
  const legacy = {
    jobId: id,
    owner: x.owner,
    target: x.target,
    status: "running",
    steps: [],
    results: [],
  };
  await writeFile(path.join(root, id + ".json"), JSON.stringify(legacy));
  const recovered = await x.service.jobStatus(
    { ...x.owner, cwd: tmpdir() },
    { jobId: id },
  );
  assert.equal(recovered.status, "interrupted");
  await assert.rejects(
    x.service.jobStatus({ ...x.owner, sessionId: "foreign" }, { jobId: id }),
    { code: "FOREIGN_JOB" },
  );
  assert.equal((await x.service.listJobs(x.owner)).total, 1);
});

test("bounded task and request caches refuse unsafe eviction or replay", async (t) => {
  const x = await fixture(t);
  const { job } = await execute(x);
  assert.equal((await x.service.listJobs(x.owner)).jobs[0].results.length, 0);
  // Exercise hard admission gates without issuing 1024 debugger actions.
  for (let i = 0; i < 128; i++)
    x.service.completed.set("fixture-" + i, {
      ...job,
      persistence: { status: "failed" },
    });
  const p = await x.service.preview(x.owner, { steps: [step("continue")] });
  await assert.rejects(
    x.service.execute(x.owner, { previewId: p.previewId, confirmed: true }),
    { code: "CAPACITY" },
  );
  for (let i = 0; i < 1024; i++)
    x.service.requests.set("fixture-" + i, {
      signature: "",
      result: Promise.resolve(job.jobId),
    });
  await assert.rejects(
    x.service.execute(x.owner, {
      previewId: p.previewId,
      confirmed: true,
      requestId: "bounded",
    }),
    { code: "CAPACITY" },
  );
  assert(!x.calls.includes("continue"));
});

test("disk listing failure preserves requestId recovery from memory with explicit incomplete evidence", async (t) => {
  const x = await fixture(t, { failSave: (job) => job.status === "succeeded" });
  const { job } = await execute(x, [step("continue")], {
    requestId: "memory-only",
  });
  x.store.list = async () => {
    throw Object.assign(Error("disk unavailable"), { code: "EIO" });
  };
  const listed = await x.service.listJobs(x.owner, {
    requestId: "memory-only",
  });
  assert.equal(listed.jobs[0].jobId, job.jobId);
  assert.equal(listed.jobs[0].status, "persistence_failed");
  assert.equal(listed.storageUnavailable, true);
  assert.equal(listed.incomplete, true);
  assert.equal(listed.error.code, "EIO");
  assert.equal(listed.total, 1);
  assert.equal((await x.service.currentJob(x.owner)).jobId, job.jobId);
  const foreign = await x.service.listJobs({
    ...x.owner,
    sessionId: "foreign",
  });
  assert.equal(foreign.jobs.length, 0);
  assert.equal(foreign.storageUnavailable, true);
  assert.equal(foreign.incomplete, true);
  await assert.rejects(
    x.service.currentJob({ ...x.owner, sessionId: "foreign" }),
    { code: "STORAGE_UNAVAILABLE" },
  );
  assert.equal(x.calls.filter((method) => method === "continue").length, 1);
});

test("listing EIO still exposes active same-session tasks without hiding unavailable storage", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const x = await fixture(t, {
    onAction: async (method, signal) => {
      if (method !== "snapshot") return;
      entered();
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const { job } = await execute(
    x,
    [step("snapshot")],
    { requestId: "active-memory" },
    false,
  );
  await started;
  x.store.list = async () => {
    throw Object.assign(Error("disk unavailable"), { code: "EIO" });
  };
  const listed = await x.service.listJobs(
    { ...x.owner, cwd: tmpdir() },
    { requestId: "active-memory" },
  );
  assert.equal(listed.jobs[0].jobId, job.jobId);
  assert.equal(listed.storageUnavailable, true);
  assert.equal(listed.incomplete, true);
  await x.service.cancel(x.owner, { jobId: job.jobId });
});
