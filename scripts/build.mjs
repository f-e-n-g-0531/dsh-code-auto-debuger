import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sourceHash } from "./provenance.mjs";
const source = await sourceHash();
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/plugin.ts"],
  outfile: "dist/plugin.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
});
await build({
  entryPoints: ["src/client/index.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  external: ["react"],
  banner: {
    js:
      "window.__ModuleLoader__.load({id:" +
      JSON.stringify(pkg.name) +
      ",factory(require){var module={exports:{}};var exports=module.exports;",
  },
  footer: { js: "return module.exports;}});" },
});
if ((await sourceHash()) !== source)
  throw Error("Sources changed during build");
const hash = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
await writeFile(
  "dist/build-info.json",
  JSON.stringify(
    {
      version: pkg.version,
      protocol: 1,
      sourceHash: source,
      pluginHash: await hash("dist/plugin.js"),
      clientHash: await hash("dist/client.js"),
    },
    null,
    2,
  ) + "\n",
);
