import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { artifactDirectory, validateArchive } from "./ci/release-check.mjs";
import { sha256 } from "./provenance.mjs";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const directory = artifactDirectory(pkg);
const manifest = JSON.parse(
  await readFile(path.join(directory, "manifest.json"), "utf8"),
);
if (
  manifest.name !== pkg.name ||
  manifest.version !== pkg.version ||
  path.basename(manifest.archive) !== manifest.archive
)
  throw Error("Install manifest identity/path mismatch");
const archive = path.join(directory, manifest.archive);
if (sha256(await readFile(archive)) !== manifest.sha256)
  throw Error("Install archive hash mismatch");
await validateArchive(archive);
const root = await mkdtemp(path.join(os.tmpdir(), "dsh-auto-debug-install-"));
await writeFile(
  path.join(root, "package.json"),
  JSON.stringify({
    name: "isolated-plugin-smoke",
    private: true,
    type: "module",
  }),
);
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run through npm");
const r = spawnSync(
  process.execPath,
  [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
  { cwd: root, stdio: "inherit" },
);
if (r.status !== 0) throw Error("Isolated installation failed");
await writeFile(
  path.join(root, "smoke.mjs"),
  "import {name,inject,apply} from '@feng0531/dsh-code-auto-debuger'; if(name!=='dsh-code-auto-debuger'||typeof apply!=='function'||!inject.includes('tools')) throw Error('Invalid plugin exports'); console.log('Isolated package export smoke passed; real DSH host not claimed');",
);
const smoke = spawnSync(process.execPath, ["smoke.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (smoke.status !== 0) throw Error("Package import failed");
console.log("Isolated install retained at " + root);
