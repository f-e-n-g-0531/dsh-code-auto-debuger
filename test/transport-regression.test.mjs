import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { build } from "esbuild";
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
function fake(errorStream = "stdin") {
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  child.stdin = new Writable({
    write(chunk, enc, cb) {
      if (errorStream === "stdin")
        cb(Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
      else cb();
    },
  });
  let kills = 0;
  child.kill = () => {
    kills++;
    child.exitCode = 1;
    queueMicrotask(() => {
      child.emit("exit", 1);
      child.emit("close", 1);
    });
    return true;
  };
  return {
    child,
    get kills() {
      return kills;
    },
  };
}
test("stdin callback plus error event settles once without uncaught EPIPE", async () => {
  const f = fake();
  const c = new BridgeClient("fake", {
    spawnProcess: () => f.child,
    timeoutMs: 100,
    closeTimeoutMs: 100,
  });
  await assert.rejects(c.request("status"), { code: "OUTCOME_UNKNOWN" });
  await c.close();
  assert.equal(f.kills, 1);
  assert.equal(f.child.stdin.listenerCount("error"), 1);
});
test("stdout error aborts and cleanup is idempotent", async () => {
  const f = fake("stdout");
  const c = new BridgeClient("fake", {
    spawnProcess: () => f.child,
    timeoutMs: 100,
    closeTimeoutMs: 100,
  });
  const request = c.request("status");
  f.child.stdout.emit("error", new Error("read failed"));
  await assert.rejects(request, { code: "OUTCOME_UNKNOWN" });
  await Promise.all([c.close(), c.close()]);
  assert.equal(f.kills, 1);
});
test("cleanup reports close timeout rather than pretending process has stopped", async () => {
  const f = fake("none");
  f.child.kill = () => true;
  const c = new BridgeClient("fake", {
    spawnProcess: () => f.child,
    timeoutMs: 10,
    closeTimeoutMs: 10,
  });
  await assert.rejects(c.request("status"), { code: "OUTCOME_UNKNOWN" });
  await assert.rejects(c.close(), { code: "BRIDGE_CLEANUP_UNCONFIRMED" });
  f.child.emit("close", 1);
});
