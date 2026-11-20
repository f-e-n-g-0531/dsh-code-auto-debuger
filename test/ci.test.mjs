import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DSH can resolve localized plugin titles through package exports", async () => {
  for (const lang of ["en", "zh"]) {
    const url = import.meta.resolve(`@feng0531/dsh-code-auto-debuger/locale/${lang}.json`);
    const data = JSON.parse(await readFile(new URL(url), "utf8"));
    assert.equal(data.meta.title, "张良 / Zhang Liang");
    assert.match(data.meta.description, /Visual Studio/);
  }
});
test("package exposes built DSH entries and candidate-only scripts", async () => {
  const p = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(p.version, "0.2.0");
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
