import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import {
  sourceHash,
  inventory,
  runtimeIdentity,
  runtimeLicenseFiles,
  sha256,
} from "./provenance.mjs";
const source = await sourceHash();
if (process.platform !== "win32") throw Error("Bridge build requires Windows");
const dotnet =
  process.env.DSH_DOTNET ??
  (existsSync(".tmp/sdk/dotnet.exe") ? ".tmp/sdk/dotnet.exe" : "dotnet");
const projects = (await readdir("bridge")).filter((x) => x.endsWith(".csproj"));
if (projects.length !== 1) throw Error("Expected one bridge project");
const result = spawnSync(
  dotnet,
  [
    "publish",
    "bridge/" + projects[0],
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    "-o",
    "dist/bridge/win-x64",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const publish = "dist/bridge/win-x64";
  const runtime = await runtimeIdentity(publish);
  const licenses = await runtimeLicenseFiles(runtime);
  for (const [name, bytes] of Object.entries(licenses))
    await writeFile(publish + "/" + name, bytes);
  const files = await inventory(publish);
  const licenseHashes = Object.fromEntries(
    Object.entries(licenses).map(([name, bytes]) => [name, sha256(bytes)]),
  );
  if ((await sourceHash()) !== source)
    throw Error("Sources changed during bridge build");
  await writeFile(
    "dist/bridge-info.json",
    JSON.stringify(
      {
        schemaVersion: 2,
        protocol: 1,
        sourceHash: source,
        runtime,
        licenseHashes,
        files,
      },
      null,
      2,
    ) + "\n",
  );
}
