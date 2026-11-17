import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
const b = await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { apply } = await import(
  "data:text/javascript;base64," +
    Buffer.from(b.outputFiles[0].text).toString("base64")
);
test("host recovery remains available when current cwd no longer exists and does not grant controls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = path.join(root, "removed");
  let rpc, dispose;
  const defs = [];
  const ctx = {
    tools: { register: (x) => defs.push(x) },
    connection: { register: (_ctx, _channel, handler) => (rpc = handler) },
    sessions: { get: () => ({ header: { cwd: missing } }) },
    sessionPersistence: { stat: async () => undefined },
    on: (_event, handler) => (dispose = handler),
  };
  apply(ctx, { storageDirectory: path.join(root, "jobs") });
  t.after(() => dispose());
  const result = await rpc("listJobs", { sessionId: "owner", limit: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.jobs, []);
  const release = await rpc("disconnect", { sessionId: "owner" });
  assert.equal(release.ok, true);
  const control = await rpc("connect", {
    sessionId: "owner",
    instanceId: "x",
    solutionPath: "x",
  });
  assert.equal(control.ok, false);
  assert(defs.find((d) => d.name === "auto_debug_list_jobs"));
});
