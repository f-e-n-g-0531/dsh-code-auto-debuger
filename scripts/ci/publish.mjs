import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readTar } from "./release-check.mjs";
import { gunzipSync } from "node:zlib";
import { verifyPublicPackage } from "./npm-registry.mjs";
if (
  process.env.GITHUB_EVENT_NAME !== "push" ||
  !process.env.GITHUB_REF?.startsWith("refs/tags/v")
)
  throw Error("Publishing requires a version-tag push");
if (!process.env.NODE_AUTH_TOKEN)
  throw Error("NPM_AUTOMATION_TOKEN is not configured");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (
  process.env.GITHUB_REF_NAME !== "v" + pkg.version ||
  pkg.license !== "MIT" ||
  !/^\d+\.\d+\.\d+$/.test(pkg.version)
)
  throw Error("Tag/version/license mismatch");
async function files(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await files(file)));
    else out.push(file);
  }
  return out;
}
const all = await files(".release"),
  archives = all.filter((x) => x.endsWith(".tgz")),
  manifests = all.filter((x) => path.basename(x) === "manifest.json");
if (archives.length !== 1 || manifests.length !== 1)
  throw Error("Expected one package and manifest");
const bytes = await readFile(archives[0]),
  manifest = JSON.parse(await readFile(manifests[0], "utf8"));
if (
  manifest.name !== pkg.name ||
  manifest.version !== pkg.version ||
  manifest.commit !== process.env.GITHUB_SHA ||
  manifest.tag !== process.env.GITHUB_REF_NAME ||
  manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")
)
  throw Error("Verified artifact identity/hash mismatch");
const packed = JSON.parse(
  readTar(gunzipSync(bytes)).get("package/package.json"),
);
if (
  packed.name !== pkg.name ||
  packed.version !== pkg.version ||
  packed.license !== "MIT"
)
  throw Error("Packed identity mismatch");
const endpoint =
  "https://registry.npmjs.org/" +
  encodeURIComponent(pkg.name) +
  "/" +
  pkg.version;
let existing = await fetch(endpoint);
if (existing.ok) {
  const value = await existing.json();
  if (
    value.license !== "MIT" ||
    value.dist?.shasum !== createHash("sha1").update(bytes).digest("hex")
  )
    throw Error("Existing registry version differs; never overwrite");
  console.log("Existing exact npm artifact verified; publication not repeated");
  await verifyPublicPackage(pkg, bytes);
  process.exit(0);
}
if (existing.status !== 404)
  throw Error(
    "Cannot establish registry prepublication state: " + existing.status,
  );
const npm = process.env.npm_execpath;
const args = [
  "publish",
  archives[0],
  "--access",
  "public",
  "--tag",
  "latest",
  "--ignore-scripts",
  "--registry=https://registry.npmjs.org/",
];
const r = npm
  ? spawnSync(process.execPath, [npm, ...args], { stdio: "inherit" })
  : spawnSync("npm", args, { stdio: "inherit" });
if (r.error) throw r.error;
if (r.status !== 0)
  throw Error("npm publication failed; inspect registry before retrying");
await verifyPublicPackage(pkg, bytes);
