import { readdir, readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
// Exact generated directories only: never exclude source files named build-*.
const generated = new Set(["bridge/bin", "bridge/obj", "profiler/bin", "profiler/obj"]);
export async function inventory(root) {
  const result = {};
  async function walk(relative = "") {
    for (const entry of (
      await readdir(path.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      const full = path.join(root, name),
        stat = await lstat(full);
      if (stat.isSymbolicLink()) throw Error("Symlink not permitted: " + name);
      if (stat.isDirectory()) await walk(name);
      else if (stat.isFile()) {
        const bytes = await readFile(full);
        result[name] = { sha256: sha256(bytes), size: bytes.length };
      } else throw Error("Non-file input: " + name);
    }
  }
  await walk();
  return result;
}
export async function sourceHash(root = ".") {
  const hash = createHash("sha256");
  async function add(file) {
    hash.update(file + "\0");
    const bytes = await readFile(path.join(root, file));
    hash.update(String(bytes.length) + "\0");
    hash.update(bytes);
  }
  async function walk(dir) {
    for (const entry of (
      await readdir(path.join(root, dir), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = dir + "/" + entry.name;
      if (entry.isDirectory() && generated.has(file)) continue;
      if (entry.isSymbolicLink())
        throw Error("Build input symlink not permitted");
      if (entry.isDirectory()) await walk(file);
      else await add(file);
    }
  }
  for (const f of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "cordis.patch.yml",
  ])
    await add(f);
  for (const d of ["src", "bridge", "profiler", "scripts"]) await walk(d);
  return hash.digest("hex");
}
export async function runtimeIdentity(publish, assembly = "dsh-vs-bridge") {
  const deps = JSON.parse(
    await readFile(path.join(publish, assembly + ".deps.json"), "utf8"),
  );
  const keys = Object.keys(deps.libraries ?? {}).filter((k) =>
    k.startsWith("runtimepack.Microsoft.NETCore.App.Runtime.win-x64/"),
  );
  if (keys.length !== 1) throw Error("Expected one win-x64 .NET runtime pack");
  const version = keys[0].split("/")[1];
  if (!/^8\.0\.\d+$/.test(version)) throw Error("Unsupported runtime version");
  return { package: "Microsoft.NETCore.App.Runtime.win-x64", version };
}
export async function runtimeLicenseFiles(identity, root = ".") {
  const name = identity.package.toLowerCase();
  const candidates = [
    path.join(
      process.env.NUGET_PACKAGES ?? path.join(os.homedir(), ".nuget/packages"),
      name,
      identity.version,
    ),
    path.join(root, ".tmp/sdk/packs", identity.package, identity.version),
  ];
  for (const dir of candidates) {
    try {
      const names = await readdir(dir);
      const license = names.find((n) => /^license\.txt$/i.test(n));
      const notices = names.find((n) => /^third-party-notices\.txt$/i.test(n));
      if (license && notices)
        return {
          "DOTNET-LICENSE.txt": await readFile(path.join(dir, license)),
          "DOTNET-THIRD-PARTY-NOTICES.txt": await readFile(
            path.join(dir, notices),
          ),
        };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  throw Error(
    "Authentic runtime LICENSE/THIRD-PARTY-NOTICES unavailable for " +
      identity.package +
      "/" +
      identity.version +
      "; restore the matching official runtime pack (no fabricated fallback)",
  );
}
