import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("npm diagnostic is manual, main-only, read-only and never publishes or approves", async () => {
  const y = (
    await readFile(".github/workflows/npm-diagnose.yml", "utf8")
  ).replace(/\r\n/g, "\n");
  assert(y.includes("workflow_dispatch:"));
  assert(!/^  (push|pull_request|schedule):/m.test(y));
  assert(y.includes("github.ref == 'refs/heads/main'"));
  assert(y.includes("contents: read"));
  assert(!y.includes("contents: write"));
  const source = await readFile("scripts/ci/npm-diagnose.mjs", "utf8");
  assert(/\[\s*["']stage["']\s*,\s*["']list["']\s*,\s*name/.test(source));
  assert(!source.includes("'approve'"));
  assert(!source.includes("'publish'"));
  assert(!source.includes("console.log(result.stdout)"));
});
