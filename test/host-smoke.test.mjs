import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apply } from "../dist/plugin.js";

// Prefer declared local SDK dependencies. The sibling checkout is an optional,
// read-only developer fixture, never an installed DSH profile or application.
function sdkLocation() {
  const bases = [new URL("../package.json", import.meta.url)];
  if (process.env.DSH_SDK_FIXTURE)
    bases.push(path.join(process.env.DSH_SDK_FIXTURE, "package.json"));
  // CI uses the fixed local SDK dependency; no implicit sibling checkout fallback.
  for (const base of bases) {
    const resolve = createRequire(base).resolve;
    try {
      return {
        tools: resolve("@deepseek-ai/dsh-tools"),
        cordis: resolve("@deepseek-ai/cordis"),
      };
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
}
const sdkPaths = sdkLocation();
assert(
  sdkPaths,
  "Fixed local DSH SDK dependencies are required; npm ci before host tests",
);
const sdk = sdkPaths ? await import(pathToFileURL(sdkPaths.tools).href) : null;
const cordis = sdkPaths
  ? await import(pathToFileURL(sdkPaths.cordis).href)
  : null;

async function fixture(t, tools) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-debug-host-smoke-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const definitions = [],
    disposers = [];
  let rpc, profilerRpc;
  const ctx = {
    tools: tools ?? {
      register(definition) {
        definitions.push(definition);
      },
    },
    connection: {
      register(owner, channel, handler) {
        assert.equal(owner, ctx);
        assert.match(channel, /^\/auto-debug(?:-profiler)?-rpc$/);
        if (channel === "/auto-debug-rpc") rpc = handler;
        else profilerRpc = handler;
      },
    },
    sessions: {
      get(id) {
        return id === "live" ? { header: { id, cwd: workspace } } : undefined;
      },
    },
    sessionPersistence: {
      async stat(id) {
        return id === "persisted"
          ? { header: { id, cwd: workspace } }
          : undefined;
      },
    },
    on(event, handler) {
      assert.equal(event, "dispose");
      disposers.push(handler);
    },
  };
  const activate = () => apply(ctx, { storageDirectory: path.join(root, "jobs") });
  const service = activate();
  const reloadProfiler = async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    activate();
    return profilerRpc;
  };
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { ctx, service, definitions, rpc, profilerRpc, workspace, reloadProfiler };
}

test("host RPC contract matches browser flat payload and enforces session ownership", async (t) => {
  const x = await fixture(t);
  const caps = await x.rpc("capabilities", { sessionId: "live" });
  assert.equal(caps.ok, true);
  assert.equal(caps.value.protocol, 1);
  assert.equal(
    caps.value.verified,
    false,
    "smoke is not real Visual Studio acceptance",
  );
  assert.equal(
    (await x.rpc("capabilities", { sessionId: "persisted" })).ok,
    true,
  );
  for (const sessionId of ["missing", "", "../escape", "x/y", "x\\y"])
    assert.equal(
      (await x.rpc("capabilities", { sessionId })).error.code,
      "INVALID_OWNER",
    );
  assert.equal(
    (await x.rpc("launch", { sessionId: "live" })).error.code,
    "UNKNOWN_ACTION",
  );
  assert.equal(
    (await x.rpc("capabilities", { sessionId: "live", unexpected: true })).ok,
    false,
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await x.rpc("capabilities", { sessionId: "live" }, abort.signal)).ok,
    false,
  );
});

test("performance RPC scopes imported traces to their owning session", { skip: process.platform !== "win32" }, async (t) => {
  const x = await fixture(t);
  const own = { sessionId: "live" };
  await writeFile(path.join(x.workspace, "sample.etl"), "test fixture; not parsed");
  assert.equal((await x.profilerRpc("import", { ...own, etlPath: "../escape.etl" })).ok, false);
  const imported = await x.profilerRpc("import", { ...own, etlPath: "sample.etl" });
  assert.equal(imported.ok, true);
  const { traceId } = imported.value;
  assert.equal((await x.profilerRpc("current", own)).value.traceId, traceId);
  assert.deepEqual((await x.profilerRpc("current", { sessionId: "persisted" })).value, {});
  assert.equal((await x.profilerRpc("close", { sessionId: "persisted", traceId })).error.code, "PROFILER_TRACE");
  assert.equal((await x.profilerRpc("import", { ...own, etlPath: "sample.etl" })).error.code, "PROFILER_TRACE");
  for (const [replaceTraceId, code] of [["stale", "PROFILER_TRACE"], [traceId, "PROFILER_INPUT"]]) {
    assert.equal((await x.profilerRpc("record", { ...own, replaceTraceId })).error.code, code);
    assert.equal((await x.profilerRpc("current", own)).value.traceId, traceId);
  }
  assert.equal((await x.profilerRpc("close", { ...own, traceId })).ok, true);
  assert.equal((await x.profilerRpc("import", { ...own, etlPath: "sample.etl" })).ok, true, "closing a trace must not remove the original");
});

test("profiler imports survive disposal and restore only to their owner", { skip: process.platform !== "win32" }, async t => {
  const x = await fixture(t);
  await writeFile(path.join(x.workspace, "sample.etl"), "fixture");
  const own = {sessionId:"live"};
  const r = await x.profilerRpc("import", {...own, etlPath:"sample.etl"});
  assert.equal(r.ok,true);
  const next = await x.reloadProfiler();
  assert.equal((await next("current",own)).value.traceId, r.value.traceId);
  assert.deepEqual((await next("current",{sessionId:"persisted"})).value, {});
  assert.equal((await next("close",{...own,traceId:r.value.traceId})).ok,true);
  const afterClose = await x.reloadProfiler();
  assert.deepEqual((await afterClose("current",own)).value, {});
});

test("profiler defaults are persisted and shared across sessions", { skip: process.platform !== "win32" }, async t => {
  const x = await fixture(t);
  const saved = { processFilter: "soul", duration: 15, pdb: "D:/Symbols/中文字" };
  assert.equal((await x.profilerRpc("saveDefaults", {sessionId:"live", ...saved})).ok, true);
  assert.deepEqual((await x.profilerRpc("getDefaults", {sessionId:"persisted"})).value, saved);
  assert.equal((await x.profilerRpc("saveDefaults", {sessionId:"live", ...saved, duration:16})).ok, false);
  assert.deepEqual((await x.profilerRpc("getDefaults", {sessionId:"live"})).value, saved);
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(JSON.parse(await readFile(path.join(x.workspace, "..", "jobs", "profiler-defaults.json"), "utf8")), saved);
});

test("RPC failures meet the DSH wire contract and preserve error details", async (t) => {
  const x = await fixture(t);
  for (const [rpc, action] of [[x.rpc, "capabilities"], [x.profilerRpc, "processes"]]) {
    const reply = JSON.parse(JSON.stringify(await rpc(action, { sessionId: "missing" })));
    assert.deepEqual(reply, {ok:false,error:{ code:"INVALID_OWNER", message:"Session unavailable", details:{} }});
  }
});

test("host tool calls derive owner from execution context, never model arguments", async (t) => {
  const x = await fixture(t);
  assert.equal(x.definitions.length, 16);
  assert.equal(new Set(x.definitions.map((d) => d.name)).size, 16);
  const capabilities = x.definitions.find(
    (d) => d.name === "auto_debug_capabilities",
  );
  assert.equal(
    (
      await capabilities.execute(
        {},
        { agent: { session: { header: { id: "live" } } } },
      )
    ).protocol,
    1,
  );
  await assert.rejects(
    capabilities.execute({}, { agent: { session: { id: "missing" } } }),
    { code: "INVALID_OWNER" },
  );
  await assert.rejects(
    capabilities.execute(
      { sessionId: "persisted" },
      { agent: { session: { id: "live" } } },
    ),
  );
  assert(
    x.definitions.every((d) => d.parameters.additionalProperties === false),
  );
});

test(
  "real DSH SDK registry accepts all outputs and projects sixteen schemas",
  {},
  async (t) => {
    t.diagnostic("DSH SDK tools: " + sdkPaths.tools);
    const ctx = new cordis.Context();
    ctx.provide("systemPrompt", { tools() {} });
    const registry = new sdk.ToolsService(ctx);
    const x = await fixture(t, registry);
    const definitions = registry.definitions();
    assert.equal(definitions.length, 16);
    const schemas = registry.schemas();
    assert.equal(schemas.length, 16);
    assert(
      schemas.every(
        (schema) =>
          typeof schema.name === "string" &&
          !("execute" in schema) &&
          !("output" in schema),
      ),
    );
    for (const definition of definitions) {
      sdk.assertSupportedJsonSchema(definition.output.schema);
      const value =
        definition.name === "auto_debug_capabilities"
          ? await definition.execute({}, { agent: { session: { id: "live" } } })
          : { status: "unknown", externalState: "unknown", fixture: true };
      assert.deepEqual(
        sdk.validateJsonSchemaValue(definition.output.schema, value),
        [],
        definition.name,
      );
      const rendered = await definition.output.render({}, value);
      assert.deepEqual(JSON.parse(rendered[0].text), value);
      assert.equal(rendered[0].type, "text");
      assert(
        sdk.validateJsonSchemaValue(definition.output.schema, null).length > 0,
      );
    }
    assert.equal((await x.rpc("capabilities", { sessionId: "live" })).ok, true);
  },
);
