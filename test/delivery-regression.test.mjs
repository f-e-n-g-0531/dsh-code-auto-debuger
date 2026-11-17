import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  sourceHash,
  inventory,
  sha256,
  runtimeLicenseFiles,
} from "../scripts/provenance.mjs";
import { verifyPackage } from "../scripts/verify-package.mjs";
import {
  readTar,
  verifyEntries,
  requiredInventory,
  semver,
  artifactDirectory,
} from "../scripts/ci/release-check.mjs";
const put = async (root, name, bytes) => {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
};
const json = async (root, name, value) =>
  put(root, name, JSON.stringify(value));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "delivery-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const f of [
    "package-lock.json",
    "tsconfig.json",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "scripts/build-bridge.mjs",
    "src/plugin.ts",
    "bridge/Program.cs",
    "docs/guide.md",
    "locale/en.yml",
    "dist/client.js",
    "dist/plugin.js",
  ])
    await put(root, f, "fixture " + f);
  await json(root, "package.json", { name: "test-fixture", version: "0.1.1" });
  const publish = "dist/bridge/win-x64";
  await put(
    root,
    publish + "/dsh-vs-bridge.exe",
    "not executable: test fixture only",
  );
  await json(root, publish + "/dsh-vs-bridge.deps.json", {
    libraries: {
      "runtimepack.Microsoft.NETCore.App.Runtime.win-x64/8.0.34": {},
    },
  });
  // Synthetic notices remain exclusively in a disposable test root, never in dist.
  const old = process.env.NUGET_PACKAGES;
  process.env.NUGET_PACKAGES = path.join(root, "nuget");
  t.after(() => {
    if (old === undefined) delete process.env.NUGET_PACKAGES;
    else process.env.NUGET_PACKAGES = old;
  });
  await put(
    root,
    "nuget/microsoft.netcore.app.runtime.win-x64/8.0.34/LICENSE.TXT",
    "TEST ONLY license",
  );
  await put(
    root,
    "nuget/microsoft.netcore.app.runtime.win-x64/8.0.34/THIRD-PARTY-NOTICES.TXT",
    "TEST ONLY notices",
  );
  const runtime = {
    package: "Microsoft.NETCore.App.Runtime.win-x64",
    version: "8.0.34",
  };
  const licenses = await runtimeLicenseFiles(runtime, root);
  for (const [name, bytes] of Object.entries(licenses))
    await put(root, publish + "/" + name, bytes);
  const source = await sourceHash(root);
  await json(root, "dist/build-info.json", {
    version: "0.1.1",
    protocol: 1,
    sourceHash: source,
    clientHash: sha256(await readFile(path.join(root, "dist/client.js"))),
    pluginHash: sha256(await readFile(path.join(root, "dist/plugin.js"))),
  });
  const metadata = {
    schemaVersion: 2,
    protocol: 1,
    sourceHash: source,
    runtime,
    licenseHashes: Object.fromEntries(
      Object.entries(licenses).map(([f, b]) => [f, sha256(b)]),
    ),
    files: await inventory(path.join(root, publish)),
  };
  await json(root, "dist/bridge-info.json", metadata);
  return { root, publish, metadata };
}
test("build-* scripts and unknown build-* directories are hashed; only exact generated directories ignored", async (t) => {
  const { root } = await fixture(t);
  const first = await sourceHash(root);
  await put(root, "bridge/obj/generated", "generated");
  assert.equal(await sourceHash(root), first);
  await put(root, "scripts/build-bridge.mjs", "changed");
  assert.notEqual(await sourceHash(root), first);
  const second = await sourceHash(root);
  await put(root, "bridge/build-custom/input", "source");
  assert.notEqual(await sourceHash(root), second);
});
test("publish verification accepts intact fixture and rejects changed, missing, additional files and forged licenses", async (t) => {
  const { root, publish, metadata } = await fixture(t);
  await verifyPackage(root);
  const exe = publish + "/dsh-vs-bridge.exe",
    original = await readFile(path.join(root, exe));
  await put(root, exe, "modified");
  await assert.rejects(verifyPackage(root), /inventory/);
  await rm(path.join(root, exe));
  await assert.rejects(verifyPackage(root), /inventory/);
  await put(root, exe, original);
  await put(root, publish + "/extra.dll", "extra");
  await assert.rejects(verifyPackage(root), /inventory/);
  await rm(path.join(root, publish + "/extra.dll"));
  await put(root, publish + "/DOTNET-LICENSE.txt", "forged license");
  metadata.files = await inventory(path.join(root, publish));
  metadata.licenseHashes["DOTNET-LICENSE.txt"] = sha256(
    Buffer.from("forged license"),
  );
  await json(root, "dist/bridge-info.json", metadata);
  await assert.rejects(verifyPackage(root), /Runtime license mismatch/);
});
test("nested SDK assembly is rejected even when publish inventory is regenerated", async (t) => {
  const x = await fixture(t);
  await put(
    x.root,
    x.publish + "/subdir/Microsoft.VisualStudio.Interop.dll",
    "restricted-test-placeholder",
  );
  x.metadata.files = await inventory(path.join(x.root, x.publish));
  await json(x.root, "dist/bridge-info.json", x.metadata);
  await assert.rejects(verifyPackage(x.root), /Do not redistribute/);
});
test("source hash mismatch and runtime identity mismatch fail closed", async (t) => {
  const { root, metadata } = await fixture(t);
  metadata.runtime.version = "8.0.35";
  await json(root, "dist/bridge-info.json", metadata);
  await assert.rejects(verifyPackage(root), /runtime identity/);
  metadata.runtime.version = "8.0.34";
  metadata.sourceHash = "0".repeat(64);
  await json(root, "dist/bridge-info.json", metadata);
  await assert.rejects(verifyPackage(root), /sources/);
});
test("unavailable official runtime notices are an explicit failure", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    runtimeLicenseFiles(
      { package: "Microsoft.NETCore.App.Runtime.win-x64", version: "8.0.9999" },
      root,
    ),
    /Authentic runtime.*unavailable/,
  );
});
test("all required package bytes are checked, not only dist", async (t) => {
  const { root } = await fixture(t);
  const expected = await requiredInventory(root);
  verifyEntries(new Map(expected), expected);
  for (const name of [
    "package/package.json",
    "package/cordis.patch.yml",
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/dist/build-info.json",
    "package/dist/bridge-info.json",
    "package/docs/guide.md",
    "package/locale/en.yml",
  ]) {
    const changed = new Map(expected);
    changed.set(name, Buffer.from("changed"));
    assert.throws(() => verifyEntries(changed, expected), /stale/);
    const missing = new Map(expected);
    missing.delete(name);
    assert.throws(() => verifyEntries(missing, expected), /inventory/);
  }
  const extra = new Map(expected);
  extra.set("package/unexpected", Buffer.from("extra"));
  assert.throws(() => verifyEntries(extra, expected), /inventory/);
});
function tar(entries) {
  const parts = [];
  for (const [name, body = Buffer.from("x"), type = "0"] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.fill(32, 148, 156);
    h.write(type, 156);
    h.write("ustar\0", 257);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
test("tar parser rejects link/device/directory/PAX types, duplicate paths, traversal, Windows aliases and corruption", () => {
  assert.equal(
    readTar(tar([["package/a"]]))
      .get("package/a")
      .toString(),
    "x",
  );
  for (const type of ["1", "2", "3", "4", "5", "6", "x", "g", "L"])
    assert.throws(
      () => readTar(tar([["package/a", Buffer.from("x"), type]])),
      /regular/,
    );
  for (const name of [
    "package/../a",
    "package/./a",
    "/package/a",
    "package/a:b",
    "package/a\\b",
    "package/a.",
    "package/CON",
    "package//a",
  ])
    assert.throws(() => readTar(tar([[name]])), /Unsafe/);
  for (const name of ["package/a", "package/A"])
    assert.throws(() => readTar(tar([["package/a"], [name]])), /Duplicate/);
  const corrupt = tar([["package/a"]]);
  corrupt[0] ^= 1;
  assert.throws(() => readTar(corrupt), /checksum/);
  assert.throws(
    () => readTar(tar([["package/a"]]).subarray(0, 1024)),
    /terminator/,
  );
});
test("version-independent semver and versioned artifact directory", () => {
  for (const version of ["0.1.1", "1.2.3-rc.1", "2.0.0+build"])
    assert(semver.test(version));
  for (const version of ["01.1.1", "0.1", "1.2.3-01"])
    assert(!semver.test(version));
  if (!process.env.DSH_AUTO_DEBUG_ARTIFACT_DIR)
    assert.equal(
      artifactDirectory({ version: "0.1.1" }),
      path.resolve(".artifacts/0.1.1"),
    );
});
