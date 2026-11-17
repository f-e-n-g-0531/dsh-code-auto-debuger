import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  sourceHash,
  sha256,
  inventory,
  runtimeIdentity,
  runtimeLicenseFiles,
} from "./provenance.mjs";
export async function verifyPackage(root = ".") {
  const json = async (f) =>
    JSON.parse(await readFile(path.join(root, f), "utf8"));
  const p = await json("package.json"),
    info = await json("dist/build-info.json");
  if (
    p.version !== info.version ||
    info.protocol !== 1 ||
    info.sourceHash !== (await sourceHash(root))
  )
    throw Error("Build metadata mismatch");
  for (const [file, key] of [
    ["dist/plugin.js", "pluginHash"],
    ["dist/client.js", "clientHash"],
  ]) {
    if (sha256(await readFile(path.join(root, file))) !== info[key])
      throw Error("Artifact hash mismatch: " + file);
  }
  const publish = path.join(root, "dist/bridge/win-x64");
  const bridge = await json("dist/bridge-info.json");
  if (
    bridge.schemaVersion !== 2 ||
    bridge.protocol !== 1 ||
    bridge.sourceHash !== info.sourceHash
  )
    throw Error("Bridge sources and plugin build differ");
  const actual = await inventory(publish);
  if (
    Object.keys(actual).some((name) =>
      /^Microsoft\.VisualStudio.*Interop.*\.dll$/i.test(path.basename(name)),
    )
  )
    throw Error("Do not redistribute build-time Visual Studio SDK assemblies");
  if (
    !isDeepStrictEqual(bridge.files, actual) ||
    !(actual["dsh-vs-bridge.exe"]?.size > 0)
  )
    throw Error("Bridge publish inventory mismatch");
  const runtime = await runtimeIdentity(publish);
  if (!isDeepStrictEqual(bridge.runtime, runtime))
    throw Error("Bridge runtime identity mismatch");
  // Compare with the actual matching official runtime pack, not just self-reported metadata.
  const licenses = await runtimeLicenseFiles(runtime, root);
  if (
    !isDeepStrictEqual(
      Object.keys(bridge.licenseHashes ?? {}).sort(),
      Object.keys(licenses).sort(),
    )
  )
    throw Error("Runtime license inventory mismatch");
  for (const [file, bytes] of Object.entries(licenses)) {
    if (
      !bytes.length ||
      bridge.licenseHashes[file] !== sha256(bytes) ||
      !(await readFile(path.join(publish, file))).equals(bytes)
    )
      throw Error("Runtime license mismatch: " + file);
  }
  for (const file of [
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    if (!(await readFile(path.join(root, file))).length)
      throw Error("Empty required file: " + file);
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name),
        stat = await lstat(f);
      if (stat.isSymbolicLink()) throw Error("Symlink not allowed: " + f);
      if (stat.isDirectory()) await scan(f);
      else if (!stat.isFile() || /\.(?:tmp|tgz|pdb|user|log)$/i.test(e.name))
        throw Error("Unexpected artifact: " + f);
    }
  }
  await scan(path.join(root, "dist"));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await verifyPackage();
  console.log("Package artifact checks passed (not real VS acceptance)");
}
