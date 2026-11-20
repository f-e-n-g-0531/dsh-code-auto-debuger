import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
const result = await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { apply, inject } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
async function host(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dynamic-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let rpc, dispose;
  const defs = [];
  apply(
    {
      tools: { register: (d) => defs.push(d) },
      connection: { register: (_ctx, channel, handler) => { if (channel === "/auto-debug-rpc") rpc = handler; } },
      sessions: {
        get: (id) => (id === "owner" ? { header: { cwd } } : undefined),
      },
      sessionPersistence: { stat: async () => undefined },
      on: (event, fn) => (dispose = fn),
    },
    { storageDirectory: cwd + "-jobs" },
  );
  t.after(() => dispose());
  return { defs, rpc, cwd };
}
test("AI-led tools are explicit and do not demand a user-authored plan", async (t) => {
  const x = await host(t);
  for (const action of ["begin", "perform", "investigation", "takeover"])
    assert(x.defs.some((d) => d.name === "auto_debug_" + action));
  const begin = x.defs.find((d) => d.name === "auto_debug_begin"),
    perform = x.defs.find((d) => d.name === "auto_debug_perform");
  assert.deepEqual(begin.parameters.required, ["goal", "confirmed"]);
  assert(!begin.parameters.properties.steps);
  assert(!begin.parameters.properties.timeoutMs);
  assert.match(perform.description, /ONE AI-chosen/);
  assert.deepEqual(perform.parameters.required, [
    "investigationId",
    "requestId",
    "action",
    "params",
  ]);
  assert(inject.includes("webServer"));
  const caps = await x.rpc("capabilities", { sessionId: "owner" });
  assert.equal(caps.value.features.dynamicDebug, true);
  assert.equal(caps.value.features.observerPanel, true);
});
test("panel cannot create authorization, perform debugging or invoke legacy execution", async (t) => {
  const x = await host(t);
  for (const action of ["begin", "perform", "preview", "execute"]) {
    const r = await x.rpc(action, { sessionId: "owner" });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "TOOL_ONLY");
  }
  const view = await x.rpc("investigation", { sessionId: "owner" });
  assert.equal(view.ok, true);
  assert.equal(view.value.status, "idle");
  const take = await x.rpc("takeover", { sessionId: "owner" });
  assert.equal(take.ok, true);
});
test("dynamic tools derive session identity from actual tool context", async (t) => {
  const x = await host(t),
    begin = x.defs.find((d) => d.name === "auto_debug_begin");
  await assert.rejects(
    begin.execute(
      { goal: "investigate", confirmed: true },
      { agent: { session: { id: "foreign" } } },
    ),
    { code: "INVALID_OWNER" },
  );
  await assert.rejects(
    begin.execute(
      { goal: "investigate", confirmed: true, sessionId: "owner" },
      { agent: { session: { id: "owner" } } },
    ),
  );
});
