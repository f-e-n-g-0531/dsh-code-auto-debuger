import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  markerLine,
  assertBreakpointHit,
  assertAdvancement,
  ownedDescendants,
  microIdentity,
  lineageRoots,
  OwnedProcessLedger,
} from "../bridge/smoke-helpers.mjs";

test("fixture markers resolve exact executable lines", async () => {
  assert.equal(await markerLine("test/fixtures/cpp/main.cpp"), 10);
  assert.equal(await markerLine("test/fixtures/csharp/Program.cs"), 11);
  await assert.rejects(
    markerLine("test/fixtures/cpp/main.cpp", "missing-marker"),
  );
});
test("smoke evidence rejects unrelated stops and synthetic stop-id advancement", () => {
  const before = {
    state: "break",
    variablesEvaluated: false,
    stack: [{ function: "Add(int,int)" }],
    position: { file: "fixture.cpp", line: 10 },
  };
  assertBreakpointHit(before, "fixture.cpp", 10);
  assert.throws(
    () => assertBreakpointHit(before, "other.cpp", 10),
    /not_verified/,
  );
  assert.throws(
    () => assertBreakpointHit(before, "fixture.cpp", 11),
    /not_verified/,
  );
  assert.throws(
    () => assertBreakpointHit(before, "fixture.cpp", 10, "main"),
    /Expected paused/,
  );
  assert.throws(
    () => assertAdvancement(before, { ...before, stopId: "different" }),
    /not_verified/,
  );
  assert.throws(
    () => assertAdvancement(before, { ...before, position: null }),
    /not_verified/,
  );
  assertAdvancement(before, {
    ...before,
    position: { file: "fixture.cpp", line: 11 },
  });
});
test("ownership ledger excludes same-name, preexisting and reused-parent processes", () => {
  const time = (n) =>
    "2026-11-17T00:00:" + String(n).padStart(2, "0") + ".0000000Z";
  const rows = [
    { pid: 2, parentPid: 1, startTime: time(2), name: "fixture" },
    { pid: 3, parentPid: 2, startTime: time(3) },
    { pid: 4, parentPid: 99, startTime: time(4), name: "fixture" },
    { pid: 5, parentPid: 1, startTime: time(0) },
    { pid: 6, parentPid: 1, startTime: time(3) },
  ];
  assert.deepEqual(
    [
      ...ownedDescendants(
        rows,
        new Map([[1, time(1)]]),
        new Set(["6@" + time(3)]),
      ).keys(),
    ],
    [2, 3],
  );
});
test("PowerShell startup is protected and no Bridge string/process variable collision", async () => {
  const ps = await readFile("bridge/IntegrationSmoke.ps1", "utf8");
  assert.ok(ps.includes("[string]$BridgePath"));
  assert.ok(!ps.toLowerCase().includes("$bridge ="));
  assert.ok(ps.lastIndexOf("try {") > 0);
  assert.ok(
    ps.indexOf("try {\n    # Every creation") <
      ps.indexOf("$vs = Start-Process"),
  );
  assert.match(ps, /listOwnedBreakpoints/);
  assert.ok(
    ps.lastIndexOf("Write-Host 'PASS") >
      ps.indexOf("Cleanup failed (NOT PASS)"),
  );
});

test("micro lineage retains reparented roots while cleanup captures newly born descendants", async () => {
  const exact = "2026-11-17T00:00:01.1234567Z",
    cim = "2026-11-17T00:00:01.1234560Z";
  assert.equal(microIdentity(exact), microIdentity(cim));
  assert.deepEqual(
    [...lineageRoots([{ pid: 2, startTime: cim }], new Map([[2, exact]]))],
    [[2, microIdentity(exact)]],
  );
  assert.equal(
    lineageRoots(
      [{ pid: 2, startTime: "2026-11-17T00:00:01.1234570Z" }],
      new Map([[2, exact]]),
    ).size,
    0,
  );
  const root = { pid: 1, startTime: "2026-11-17T00:00:00.0000001Z" };
  const times = new Map([
    [1, root.startTime],
    [2, exact],
    [3, "2026-11-17T00:00:02.1234567Z"],
    [4, "2026-11-17T00:00:03.1234567Z"],
  ]);
  let rows = [
    { pid: 1, parentPid: 99, startTime: root.startTime },
    { pid: 2, parentPid: 1, startTime: cim },
  ];
  const stopped = [];
  const ledger = new OwnedProcessLedger(root, true, {
    processes: async () => rows.map((r) => ({ ...r })),
    processIdentity: async (pid) => ({ pid, startTime: times.get(pid) }),
    stopExact: async (pid, start) => {
      assert.equal(start, times.get(pid));
      stopped.push(pid);
      rows = rows.filter((r) => r.pid !== pid);
      if (pid === 2)
        rows.push({ pid: 4, parentPid: 3, startTime: times.get(4) });
    },
  });
  await ledger.initialize();
  await ledger.capture();
  // VS exited; the previously captured child reparented and created another child.
  rows = [
    { pid: 2, parentPid: 99, startTime: cim },
    { pid: 3, parentPid: 2, startTime: times.get(3) },
  ];
  await ledger.cleanup();
  assert.deepEqual(stopped, [2, 3, 4]);
  assert.deepEqual(rows, []);
});

const bridge =
  process.env.DSH_BRIDGE_TEST_EXE ??
  (process.platform === "win32"
    ? "./dist/bridge/win-x64/dsh-vs-bridge.exe"
    : undefined);
async function exchange(bytes) {
  const child = spawn(bridge, [], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [],
    stderr = [];
  const complete = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Bridge exit " + code + ": " + Buffer.concat(stderr))),
    );
  });
  const timer = setTimeout(() => child.kill(), 15000);
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  child.stdin.on("error", () => {}); // close result is authoritative
  child.stdin.end(bytes);
  try {
    await complete;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(stdout)
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}
const request = (id, method = "status", params = {}) =>
  JSON.stringify({ protocol: 1, id, method, params });
test(
  "real bridge JSONL UTF8 byte bound depth id duplicate recovery and EOF; no VS calls",
  { skip: !bridge },
  async () => {
    const records = [
      request("状态😀"),
      request(42),
      request(true),
      request("x".repeat(257)),
      '{"protocol":1,"id":"duplicate","method":"status","params":{},"params":{}}',
      request("fields", "status", { unexpected: 1 }),
      request("unknown", "bogus"),
      request("depth", "status", {
        deep: JSON.parse("[".repeat(20) + "0" + "]".repeat(20)),
      }),
      "界".repeat(22000), // fewer than 65536 chars, more than 65536 UTF8 bytes
      request("after", "disconnect"),
      request("mutate", "launch"),
      request("owned", "listOwnedBreakpoints"),
    ];
    const responses = await exchange(
      Buffer.concat([
        Buffer.from(records.join("\n") + "\n"),
        Buffer.from([0xc3, 0x28, 10]), // invalid UTF8, then recover on newline
        Buffer.from(request("after-utf8") + "\n"),
        Buffer.from(request("eof")), // complete last record without final newline
      ]),
    );
    assert.equal(responses.length, 15);
    assert.equal(responses[0].id, "状态😀");
    assert.equal(responses[0].value.state, "disconnected");
    assert.equal(responses[1].id, 42);
    for (const i of [2, 3, 4, 5, 7, 8, 12])
      assert.equal(responses[i].error.code, "INVALID_REQUEST", "record " + i);
    assert.equal(responses[6].error.code, "UNKNOWN_METHOD");
    assert.equal(responses[9].id, "after");
    assert.equal(responses[9].ok, true);
    assert.equal(responses[10].error.code, "DISCONNECTED");
    assert.deepEqual(responses[11].value.breakpoints, []);
    assert.equal(responses[13].id, "after-utf8");
    assert.equal(responses[14].id, "eof");
  },
);
test(
  "real bridge truncated EOF yields one invalid response and exits",
  { skip: !bridge },
  async () => {
    const responses = await exchange(
      Buffer.from('{"protocol":1,"id":"partial"'),
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.code, "INVALID_REQUEST");
  },
);
