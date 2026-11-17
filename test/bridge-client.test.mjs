import { existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const result = await build({
  entryPoints: ["src/bridge/client.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { BridgeClient } = await import(
  "data:text/javascript;base64," +
    Buffer.from(result.outputFiles[0].text).toString("base64")
);
test(
  "published Windows bridge handles disconnected status and graceful close",
  {
    skip: process.platform !== "win32" || false,
  },
  async () => {
    assert(
      existsSync("dist/bridge/win-x64/dsh-vs-bridge.exe"),
      "Required published bridge missing; run npm run build:bridge",
    );
    const bridge = new BridgeClient(
      path.resolve("dist/bridge/win-x64/dsh-vs-bridge.exe"),
    );
    try {
      const status = await bridge.request("status");
      assert.equal(status.state, "disconnected");
      assert.equal(status.target, null);
      await assert.rejects(bridge.request("unknown"), {
        code: "UNKNOWN_METHOD",
      });
      const process = await bridge.request("processDescribe", {
        processId: globalThis.process.pid,
      });
      assert.equal(process.processId, globalThis.process.pid);
      assert.equal(typeof process.startTime, "string");
    } finally {
      await bridge.close();
    }
    await assert.rejects(bridge.request("status"), { code: "BRIDGE_CLOSED" });
  },
);
