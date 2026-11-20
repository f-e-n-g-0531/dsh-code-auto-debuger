import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import {
  inventory,
  runtimeIdentity,
  runtimeLicenseFiles,
  sourceHash,
} from "./provenance.mjs";

if (process.platform !== "win32")
  throw Error("Profiler build requires Windows");
const publish = "dist/profiler/win-x64";
const source = await sourceHash();
const dotnet =
  process.env.DSH_DOTNET ??
  (existsSync(".tmp/sdk/dotnet.exe") ? ".tmp/sdk/dotnet.exe" : "dotnet");
const result = spawnSync(
  dotnet,
  [
    "publish",
    "profiler/Dsh.Profiler.csproj",
    "-p:RestoreLockedMode=true",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false",
    "-o",
    publish,
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
if (result.status !== 0) process.exit(result.status ?? 1);
const runtime = await runtimeIdentity(publish, "dsh-profiler");
for (const [name, bytes] of Object.entries(await runtimeLicenseFiles(runtime)))
  await writeFile(publish + "/" + name, bytes);
await copyFile(
  "profiler/TraceEvent-LICENSE.txt",
  publish + "/TraceEvent-LICENSE.txt",
);
const files = await inventory(publish);
if ((await sourceHash()) !== source)
  throw Error("Sources changed during profiler build");
await writeFile(
  "dist/profiler-info.json",
  JSON.stringify(
    { schemaVersion: 1, sourceHash: source, runtime, files },
    null,
    2,
  ) + "\n",
);
