import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reportIntegration } from "../scripts/integration-report.mjs";

test("failed outer cleanup does not leave an inner or previous pass for this run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-vs-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let prior, current;
  await reportIntegration(
    "pre-existing-vs",
    async ({ directory }) => {
      prior = directory;
      return { step: "marker confirmed" };
    },
    root,
  );
  await assert.rejects(
    reportIntegration(
      "dedicated-vs",
      async ({ directory }) => {
        current = directory;
        assert.deepEqual(await readdir(current), []);
        throw Error("outer cleanup failed after inner success");
      },
      root,
    ),
    /outer cleanup failed/,
  );
  const load = async (dir) =>
    JSON.parse(await readFile(path.join(dir, "result.json"), "utf8"));
  const before = await load(prior),
    after = await load(current);
  assert.notEqual(before.runId, after.runId);
  assert.equal(before.status, "passed");
  assert.equal(after.status, "failed");
  assert.equal(after.verified, false);
  assert.equal(after.cleanupVerified, false);
  assert.equal(after.evidence, undefined);
});
