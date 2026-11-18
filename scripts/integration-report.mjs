import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The outermost owner records the result only after all its cleanup has settled.
export async function reportIntegration(
  scope,
  run,
  root = ".artifacts/vs-runs",
) {
  const runId = randomUUID();
  const directory = path.join(root, runId);
  await mkdir(root, { recursive: true });
  await mkdir(directory);
  const identity = {
    runId,
    scope,
    commit: process.env.GITHUB_SHA ?? null,
    startedAt: new Date().toISOString(),
  };
  const file = path.join(directory, "result.json");
  console.log("VS integration run " + runId + ": " + file);
  let evidence;
  try {
    evidence = await run({ runId, directory });
  } catch (error) {
    await writeFile(
      file,
      JSON.stringify(
        {
          ...identity,
          status: "failed",
          verified: false,
          cleanupVerified: false,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw error;
  }
  await writeFile(
    file,
    JSON.stringify(
      {
        ...identity,
        status: "passed",
        verified: true,
        cleanupVerified: true,
        finishedAt: new Date().toISOString(),
        evidence,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return evidence;
}
