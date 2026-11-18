import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256 } from "./provenance.mjs";

// Prepares a hash-bound checklist, not an installation or a passing attestation.
const [manifestPath, ...extra] = process.argv.slice(2);
if (!manifestPath || extra.length)
  throw Error(
    "Usage: node scripts/prepare-host-acceptance.mjs <candidate-manifest.json>",
  );
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.kind !== "candidate-only" ||
  manifest.name !== "@feng0531/dsh-code-auto-debuger" ||
  typeof manifest.archive !== "string" ||
  !/^[a-zA-Z0-9_.-]+\.tgz$/.test(manifest.archive)
) {
  throw Error("Expected a DSH Auto Debug candidate manifest");
}
const archive = path.resolve(path.dirname(manifestPath), manifest.archive);
const bytes = await readFile(archive);
const hash = sha256(bytes);
if (bytes.length !== manifest.bytes || hash !== manifest.sha256)
  throw Error("Candidate archive identity mismatch");
const acceptanceRunId = randomUUID();
const directory = path.join(".artifacts", "dsh-host-runs", acceptanceRunId);
await mkdir(path.dirname(directory), { recursive: true });
await mkdir(directory);
await writeFile(
  path.join(directory, "checklist.json"),
  JSON.stringify(
    {
      acceptanceRunId,
      preparedAt: new Date().toISOString(),
      candidate: {
        archive: manifest.archive,
        version: manifest.version,
        commit: manifest.commit ?? null,
        sha256: hash,
        bytes: bytes.length,
      },
      environment: { dsh: null, visualStudio: null, os: null },
      status: "not-tested",
      checks: Object.fromEntries(
        [
          "cleanIsolatedProfile",
          "installedArchiveAndLoadedOrigin",
          "toolsAndIdlePanelAfterRestart",
          "conversationBeginAndPerform",
          "breakpointAndStackEvidence",
          "panelTakeover",
          "ownedCleanup",
        ].map((check) => [check, { status: "not-tested", evidence: null }]),
      ),
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log("Verified candidate SHA-256: " + hash);
console.log("Archive to install in the isolated host: " + archive);
console.log("Pending checklist: " + path.join(directory, "checklist.json"));
