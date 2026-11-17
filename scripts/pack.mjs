import { spawnSync } from "node:child_process";
import { verifyPackage } from "./verify-package.mjs";
await verifyPackage();
const r = spawnSync(
  process.execPath,
  ["scripts/ci/release-check.mjs", "--pack"],
  { stdio: "inherit" },
);
if (r.error) throw r.error;
process.exitCode = r.status ?? 1;
