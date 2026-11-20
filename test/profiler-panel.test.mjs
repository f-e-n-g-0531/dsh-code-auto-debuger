import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { act, create } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const bundle = await build({
  entryPoints: ["src/client/profiler.tsx"],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["react"],
  write: false,
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  AbortController,
});
const { ProfilerPanel } = module.exports;
const proc = { index: 42, pid: 21292, name: "soul", startMs: 0, endMs: 400 };
const soul = { pid: 21292, name: "soul", startTicks: "639307493692579749" };
const body = (node) =>
  node.children.map((c) => (typeof c === "string" ? c : body(c))).join("");
async function mount(
  t,
  {
    streams = [],
    failFrames = false,
    failAnalyze = false,
    refreshed = soul,
    failProcessList = false,
    failReplacement = false,
    reportThreads = [],
    mainThreadId = null,
    previous = {},
    savedDefaults = { processFilter: "", duration: 7, pdb: "" },
  } = {},
) {
  const calls = [];
  const connection = {
    rpc: {
      async call(channel, endpoint, args) {
        assert.equal(channel, "/auto-debug-profiler-rpc");
        assert.equal(args.sessionId, "owner");
        if (endpoint === "getDefaults")
          return {
            ok: true,
            value: savedDefaults,
          };
        if (endpoint === "current") return { ok: true, value: previous };
        if (endpoint === "saveDefaults") return { ok: true, value: args };
        if (endpoint === "processes") {
          const selected = calls.some((c) => c.endpoint === "processes")
            ? refreshed
            : soul;
          calls.push({ endpoint });
          if (failProcessList)
            throw new Error(
              "transport failure for /auto-debug-profiler-rpc/processes: HTTP 405",
            );
          return {
            ok: true,
            value: {
              processes: [
                selected,
                { pid: 7, name: "other", startTicks: "42" },
              ],
            },
          };
        }
        calls.push({ endpoint, ...args });
        if (
          (endpoint === "record" && args.replaceTraceId && failReplacement) ||
          (endpoint === "frames" && failFrames) ||
          (endpoint === "analyze" && failAnalyze)
        )
          return { ok: false, error: { code: "FAILED", message: "测试错误" } };
        return {
          ok: true,
          value: {
            record: {
              traceId: args.replaceTraceId ? "new-trace" : "trace",
              pid: 21292,
            },
            inspect: { processes: [proc] },
            frames: { streams },
            analyze: {
              samples: 17,
              stackSamples: 16,
              intervalMs: 1,
              warnings: [],
              threads: reportThreads,
              mainThreadId,
            },
          }[endpoint],
        };
      },
    },
  };
  let tree;
  await act(async () => {
    tree = create(
      React.createElement(ProfilerPanel, { connection, sessionId: "owner" }),
    );
  });
  t.after(async () => {
    await act(async () => tree.unmount());
  });
  const button = (label) =>
    tree.root.findAllByType("button").find((n) => body(n) === label);
  const select = () => tree.root.findAllByType("select")[0];
  const choose = async () => {
    const option = select()
      .findAllByType("option")
      .find((n) => body(n).includes("soul"));
    await act(async () =>
      select().props.onChange({ target: { value: option.props.value } }),
    );
  };
  const start = async () => {
    assert.equal(button("录制并分析").props.disabled, true);
    await choose();
    assert.equal(button("录制并分析").props.disabled, false);
    await act(async () => button("录制并分析").props.onClick());
  };
  return {
    tree,
    calls,
    button,
    start,
    choose,
    select,
    text: () => body(tree.root.findByProps({ className: "ad-root" })),
  };
}
test("refresh clears a PID reused by a replacement process; search matches the EXE name", async (t) => {
  const x = await mount(t, {
    refreshed: { ...soul, startTicks: "639307493692579750" },
  });
  assert.equal(x.select().props.size, 8);
  assert.match(body(x.select()), /soul.*other/);
  await x.choose();
  const search = (value) =>
    act(async () =>
      x.tree.root
        .findByProps({ placeholder: "例如 soul.exe" })
        .props.onChange({ target: { value } }),
    );
  await search("SL.EXE");
  assert.match(body(x.select()), /soul/);
  assert(!body(x.select()).includes("other"));
  await search("no-such-process");
  assert.deepEqual(
    x
      .select()
      .findAllByType("option")
      .map((o) => o.props.value),
    [""],
  );
  assert.equal(x.button("录制并分析").props.disabled, true);
  await search("");
  assert.match(body(x.select()), /soul.*other/);
  await act(async () => x.button("刷新进程").props.onClick());
  assert.equal(x.select().props.value, "");
  assert.equal(x.button("录制并分析").props.disabled, true);
  assert.deepEqual(
    x.calls.map((c) => c.endpoint),
    ["processes", "processes"],
  );
});
test("a single match has a real placeholder and is selectable without auto-recording", async (t) => {
  const x = await mount(t);
  await act(async () =>
    x.tree.root
      .findByProps({ placeholder: "例如 soul.exe" })
      .props.onChange({ target: { value: "soul" } }),
  );
  const [placeholder, process] = x.select().findAllByType("option");
  assert.equal(placeholder.props.value, x.select().props.value);
  assert.equal(placeholder.props.disabled, true);
  assert.match(body(process), /soul/);
  assert.equal(x.button("录制并分析").props.disabled, true);
  await x.choose();
  assert.equal(x.select().props.value, process.props.value);
  assert.equal(x.button("录制并分析").props.disabled, false);
  assert.deepEqual(
    x.calls.map((c) => c.endpoint),
    ["processes"],
  );
});
test("an unavailable list endpoint reports HTTP 405 instead of no matches", async (t) => {
  const x = await mount(t, { failProcessList: true });
  assert.match(x.text(), /无法加载进程列表.*HTTP 405/);
  assert.doesNotMatch(x.text(), /没有匹配的进程/);
  assert.equal(x.button("录制并分析").props.disabled, true);
});
for (const failReplacement of [false, true]) {
  test(
    "replacement recording uses current identity and " +
      (failReplacement
        ? "keeps old report on capture failure"
        : "analyzes the new trace"),
    async (t) => {
      const x = await mount(t, { failReplacement });
      await x.start();
      await act(async () => x.button("重新录制并分析").props.onClick());
      const calls = x.calls.slice(5);
      assert.equal(calls[0].replaceTraceId, "trace");
      assert.deepEqual(
        calls.map((c) => c.endpoint),
        failReplacement
          ? ["record"]
          : ["record", "inspect", "frames", "analyze"],
      );
      assert.match(x.text(), /17 个 CPU 样本/);
      if (failReplacement) assert.match(x.text(), /测试错误/);
      else assert.equal(calls.at(-1).traceId, "new-trace");
    },
  );
}
test("main thread is marked and selected; function order switches between inclusive and self CPU time", async (t) => {
  const x = await mount(t, {
    mainThreadId: 20,
    reportThreads: [
      { tid: 10, samples: 15, functions: [] },
      {
        tid: 20,
        samples: 2,
        functions: [
          { name: "OwnHot", self: 2, inclusive: 2 },
          { name: "ParentHot", self: 0, inclusive: 3 },
        ],
        stacks: [{ frames: ["caller", "callee"], samples: 2 }],
      },
    ],
  });
  await x.start();
  assert.match(x.text(), /推定主线程：TID 20/);
  const table = x.tree.root.findByType("table");
  assert.match(body(table), /ParentHot.*OwnHot/);
  const summary = x.tree.root.findByProps({ className: "ad-profiler-summary" });
  assert.match(body(summary), /OwnHot.*100.0%/);
  assert.doesNotMatch(body(summary), /ParentHot/);
  assert.match(body(table), /ParentHot—/);
  const sort = x.tree.root
    .findAllByType("select")
    .find((s) => s.props.value === "inclusive");
  await act(async () => sort.props.onChange({ target: { value: "self" } }));
  assert.match(body(table), /OwnHot.*ParentHot/);
  assert.match(body(x.tree.root.findByType("ol")), /callercallee/);
});
test("opening restores prior recording and applies saved PDB without recording", async (t) => {
  const x = await mount(t, {
    previous: { traceId: "saved", pid: 21292 },
    savedDefaults: { processFilter: "soul", duration: 15, pdb: "D:/Symbols" },
  });
  assert.deepEqual(
    x.calls.map((c) => c.endpoint),
    ["inspect", "frames", "analyze", "processes"],
  );
  assert.equal(x.calls[2].traceId, "saved");
  assert.equal(x.calls[2].pdbDir, "D:/Symbols");
  assert.equal(
    x.tree.root.findByProps({ placeholder: "例如 soul.exe" }).props.value,
    "soul",
  );
  assert.match(x.text(), /17 个 CPU 样本/);
});
const range = (x) => [x.startMs, x.endMs];
test("one recording click reports the slowest interval of the primary swap chain; selecting another interval reanalyzes without recording", async (t) => {
  const x = await mount(t, {
    streams: [
      { swapChain: "main", presents: [10, 30, 125, 145] },
      { swapChain: "secondary", presents: [0, 300] },
    ],
  });
  await x.start();
  assert.deepEqual(
    x.calls.map((c) => c.endpoint),
    ["processes", "record", "inspect", "frames", "analyze"],
  );
  assert.equal(x.calls[1].pid, soul.pid);
  assert.equal(x.calls[1].startTicks, soul.startTicks);
  assert.deepEqual(range(x.calls[4]), [30, 125]);
  assert.equal(x.calls[4].processIndex, 42);
  assert.match(x.text(), /主要交换链最慢 Present 间隔.*17 个 CPU 样本/);
  const interval = x.tree.root
    .findAllByType("button")
    .find((n) => n.props["aria-label"]?.startsWith("间隔 1："));
  await act(async () => interval.props.onClick());
  assert.deepEqual(x.calls.map((c) => c.endpoint).slice(5), ["analyze"]);
  assert.deepEqual(range(x.calls[5]), [10, 30]);
});
for (const failFrames of [false, true]) {
  test(
    (failFrames ? "failed" : "missing") +
      " Present timeline falls back to the whole recording",
    async (t) => {
      const x = await mount(t, { failFrames });
      await x.start();
      assert.deepEqual(range(x.calls[4]), [0, 400]);
      assert.match(x.text(), /整个进程录制区间.*17 个 CPU 样本/);
    },
  );
}
test("analyze failure keeps the recording available and does not retry recording", async (t) => {
  const x = await mount(t, { failAnalyze: true });
  await x.start();
  assert.match(x.text(), /测试错误/);
  assert.equal(x.button("重新录制并分析").props.disabled, false);
  await act(async () => x.button("分析此区间").props.onClick());
  assert.deepEqual(
    x.calls.map((c) => c.endpoint),
    ["processes", "record", "inspect", "frames", "analyze", "analyze"],
  );
});
