import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("package exposes built DSH entries and candidate-only scripts", async () => {
  const p = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(p.version, "0.1.1");
  assert.equal(p.exports["."], "./dist/plugin.js");
  assert.equal(p.dsh.bundle.patch, "./cordis.patch.yml");
  assert(!p.scripts.publish);
});
test("real VS workflow passes all explicit fixture parameters", async () => {
  const y = await readFile(".github/workflows/vs-integration.yml", "utf8");
  for (const env of [
    "DSH_AUTO_DEBUG_INTEGRATION",
    "DSH_AUTO_DEBUG_VS_INSTANCE",
    "DSH_AUTO_DEBUG_SOLUTION",
    "DSH_AUTO_DEBUG_SOURCE",
    "DSH_AUTO_DEBUG_LINE",
  ])
    assert(y.includes(env), env);
  assert(!y.includes("continue-on-error"));
});
