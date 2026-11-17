import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["src/client/job-store.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const storage = new Map();
function store() {
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module,
    exports: module.exports,
    sessionStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  return module.exports;
}
test("observer task store notifies replacement panels and isolates session/cwd", () => {
  storage.clear();
  const { createJobStore, sessionKey } = store(),
    jobs = createJobStore(),
    a = sessionKey({ id: "a", cwd: "one" }),
    b = sessionKey({ id: "a", cwd: "two" });
  const initial = jobs.get(a);
  let observed = initial,
    count = 0;
  const off = jobs.subscribe(() => {
    observed = jobs.get(a);
    count++;
  });
  const value = {
    jobId: "task",
    job: { status: "running" },
    requestId: "original",
    unknown: false,
  };
  jobs.set(a, value);
  assert.equal(observed, value);
  assert.equal(count, 1);
  assert.notEqual(jobs.get(b), value);
  off();
  jobs.set(a, { ...value, unknown: true });
  assert.equal(count, 1);
});
test("observer reload retains only request correlation and marks outcome unknown", () => {
  storage.clear();
  const first = store(),
    key = first.sessionKey({ id: "a", cwd: "one" });
  first
    .createJobStore()
    .set(key, {
      jobId: "secret-task",
      job: { privateValue: "not persisted" },
      requestId: "request-id",
      unknown: false,
    });
  const raw = JSON.stringify([...storage]);
  assert(raw.includes("request-id"));
  assert(!raw.includes("privateValue"));
  assert(!raw.includes("secret-task"));
  const restored = store().createJobStore().get(key);
  assert.equal(restored.requestId, "request-id");
  assert.equal(restored.jobId, "");
  assert.equal(restored.unknown, true);
});
test("explicit disconnect clears persisted request; observation never authorizes debugging", () => {
  storage.clear();
  const { createJobStore } = store(),
    jobs = createJobStore();
  jobs.set("key", {
    jobId: "id",
    job: null,
    requestId: "request",
    unknown: true,
  });
  jobs.set("key", { jobId: "", job: null, requestId: "", unknown: false });
  assert.equal(storage.size, 0);
  assert.equal(jobs.get("key").requestId, "");
});
// Panel lifecycle/reload/late-response recovery is covered by observer-panel.test.mjs.
// The removed manual plan editor is intentionally no longer a supported UI path.
