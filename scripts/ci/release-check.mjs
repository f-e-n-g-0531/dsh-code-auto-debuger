import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inventory, sha256 } from "../provenance.mjs";
import { verifyPackage } from "../verify-package.mjs";
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};
export const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function artifactDirectory(pkg, root = ".") {
  return path.resolve(
    root,
    process.env.DSH_AUTO_DEBUG_ARTIFACT_DIR || ".artifacts/" + pkg.version,
  );
}
export function readTar(tar) {
  assert(tar.length % 512 === 0, "Invalid tar alignment");
  const entries = new Map(),
    folded = new Set();
  let offset = 0,
    ended = false;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) {
      assert(
        tar.length - offset >= 1024 &&
          tar.subarray(offset).every((b) => b === 0),
        "Invalid tar terminator",
      );
      ended = true;
      break;
    }
    const text = (start, n) =>
      h
        .subarray(start, start + n)
        .toString("utf8")
        .replace(/\x00.*$/s, "");
    const oct = (start, n) => {
      const value = text(start, n).trim();
      assert(/^[0-7]+$/.test(value), "Invalid tar numeric field");
      return Number.parseInt(value, 8);
    };
    const checksum = oct(148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert(sum === checksum, "Invalid tar checksum");
    assert(h[156] === 0 || h[156] === 48, "Only regular tar files permitted");
    assert(!text(157, 100), "Tar link not permitted");
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    assert(
      name.startsWith("package/") &&
        !/[\\:\x00-\x1f\x7f]/.test(name) &&
        name
          .split("/")
          .every(
            (s) =>
              s &&
              s !== "." &&
              s !== ".." &&
              !/[. ]$/.test(s) &&
              !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
          ),
      "Unsafe archive path: " + name,
    );
    assert(!folded.has(name.toLowerCase()), "Duplicate archive entry: " + name);
    folded.add(name.toLowerCase());
    const size = oct(124, 12),
      next = offset + 512 + Math.ceil(size / 512) * 512;
    assert(
      Number.isSafeInteger(size) && next <= tar.length,
      "Invalid archive entry size",
    );
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset = next;
  }
  assert(ended, "Missing tar terminator");
  return entries;
}
export async function requiredInventory(root = ".") {
  const result = new Map();
  for (const f of [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "cordis.patch.yml",
  ]) {
    assert(
      fs.lstatSync(path.join(root, f)).isFile(),
      "Required regular file: " + f,
    );
    result.set("package/" + f, fs.readFileSync(path.join(root, f)));
  }
  for (const dir of ["dist", "docs", "locale"])
    for (const f of Object.keys(await inventory(path.join(root, dir))))
      result.set(
        "package/" + dir + "/" + f,
        fs.readFileSync(path.join(root, dir, f)),
      );
  for (const f of [
    "dist/client.js",
    "dist/plugin.js",
    "dist/build-info.json",
    "dist/bridge-info.json",
    "dist/bridge/win-x64/dsh-vs-bridge.exe",
    "dist/bridge/win-x64/DOTNET-LICENSE.txt",
    "dist/bridge/win-x64/DOTNET-THIRD-PARTY-NOTICES.txt",
  ])
    assert(
      result.get("package/" + f)?.length > 0,
      "Missing required delivery file: " + f,
    );
  return result;
}
export function verifyEntries(entries, required) {
  assert(entries.size === required.size, "Package inventory count mismatch");
  for (const [name, bytes] of required)
    assert(
      entries.get(name)?.equals(bytes),
      "Missing or stale packed file: " + name,
    );
  for (const name of entries.keys()) {
    assert(required.has(name), "Unapproved packed file: " + name);
    assert(
      !/(?:^|\/)(?:\.env(?:\.|$)|node_modules(?:\/|$))|\.vsix$/i.test(name),
      "Forbidden package content",
    );
  }
}
export async function validateArchive(archive, root = ".") {
  await verifyPackage(root);
  const required = await requiredInventory(root),
    entries = readTar(zlib.gunzipSync(fs.readFileSync(archive)));
  verifyEntries(entries, required);
  return entries;
}
export async function main(args = process.argv.slice(2)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const tagIndex = args.indexOf("--tag");
  assert(
    args.every(
      (arg, i) =>
        arg === "--pack" || arg === "--tag" || args[i - 1] === "--tag",
    ),
    "Unknown argument",
  );
  const tag =
    tagIndex < 0
      ? process.env.GITHUB_REF_TYPE === "tag"
        ? process.env.GITHUB_REF_NAME
        : ""
      : args[tagIndex + 1];
  assert(tagIndex < 0 || Boolean(tag), "--tag requires a value");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  assert(semver.test(pkg.version), "Invalid package semver");
  if (tag)
    assert(tag === "v" + pkg.version, "Tag must exactly match v" + pkg.version);
  await verifyPackage(root);
  const dir = artifactDirectory(pkg, root);
  fs.mkdirSync(dir, { recursive: true });
  if (args.includes("--pack")) {
    assert(
      !fs.readdirSync(dir).some((f) => f.endsWith(".tgz")) &&
        !fs.existsSync(path.join(dir, "manifest.json")),
      "Existing candidate: refusing overwrite",
    );
    const npm = process.env.npm_execpath;
    assert(npm && fs.existsSync(npm), "Run packing via npm run pack:candidate");
    const r = spawnSync(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--pack-destination", dir],
      { cwd: root, stdio: "inherit" },
    );
    assert(!r.error && r.status === 0, "npm pack failed");
  }
  const archives = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"));
  assert(archives.length === 1, "Exactly one candidate .tgz is required");
  const archive = path.join(dir, archives[0]),
    entries = await validateArchive(archive, root),
    bytes = fs.readFileSync(archive);
  const manifest = {
    schemaVersion: 2,
    kind: "candidate-only",
    name: pkg.name,
    version: pkg.version,
    tag: tag || null,
    commit: process.env.GITHUB_SHA || null,
    archive: archives[0],
    sha256: sha256(bytes),
    bytes: bytes.length,
    entries: entries.size,
    checks: {
      version: "passed",
      tag: tag ? "passed" : "not-requested",
      artifacts: "passed",
      packedArtifacts: "passed",
    },
    realVisualStudioIntegration: "not-attested",
    published: false,
  };
  const manifestPath = path.join(dir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const old = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert(
      old.sha256 === manifest.sha256 &&
        old.version === manifest.version &&
        old.name === manifest.name,
      "Existing manifest mismatch",
    );
  } else
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
    });
  console.log(JSON.stringify(manifest, null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error("Candidate validation FAILED:", e.message);
    process.exitCode = 1;
  });
