import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { create, act } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const compiled = await build({
  stdin: {
    contents:
      'export { Panel } from "./src/client/index.tsx"; export { createJobStore, sessionKey } from "./src/client/job-store.ts";',
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["react"],
  write: false,
  tsconfigRaw: { compilerOptions: { jsx: "react" } },
});
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  console,
  setTimeout,
  clearTimeout,
  AbortController,
});
const { Panel, createJobStore, sessionKey } = module.exports;
const session = { id: "session", cwd: "G:/workspace" };
const text = (node) =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const button = (tree, label) =>
  tree.root.findAllByType("button").find((node) => text(node) === label);
const rendered = (tree) => text(tree.root.findByType("section"));
async function click(tree, label) {
  const node = button(tree, label);
  assert(node, label);
  assert(!node.props.disabled, label + " enabled");
  await act(async () => {
    node.props.onClick();
  });
}
function backend(overrides = {}) {
  const calls = [];
  const rpc = async (action, id, args = {}, signal) => {
    calls.push({ action, id, args, signal });
    if (overrides[action]) return overrides[action](args, signal);
    return {
      capabilities: {
        version: "0.1.4",
        protocol: 1,
        features: { dynamicDebug: true },
      },
      discover: { instances: [{ instanceId: "vs", displayName: "VS 2022" }] },
      connect: {},
      status: { state: "connected", target: { instanceId: "vs" } },
      investigation: { status: "idle" },
      listJobs: { jobs: [], hasMore: false },
      takeover: { status: "revoked" },
      cancel: { jobId: "job", status: "cancelled", requestId: "req" },
      snapshot: {
        stack: [{ functionName: "main", file: "main.cpp", line: 42 }],
      },
      disconnect: {},
    }[action];
  };
  return { rpc, calls };
}
async function mount(rpc, jobs = createJobStore(), s = session) {
  let tree;
  await act(async () => {
    tree = create(React.createElement(Panel, { session: s, rpc, jobs }));
  });
  return tree;
}
async function unmount(tree) {
  await act(async () => tree.unmount());
}
async function selectConnection(tree) {
  await click(tree, "发现实例");
  await act(async () => {
    tree.root
      .findAllByType("select")[0]
      .props.onChange({ target: { value: "vs" } });
    tree.root
      .findAllByType("input")[0]
      .props.onChange({ target: { value: "G:/workspace/app.sln" } });
  });
}
const forbidden = (calls) =>
  assert(
    !calls.some((c) =>
      ["begin", "perform", "preview", "execute", "launch", "step"].includes(
        c.action,
      ),
    ),
  );

test("observer mounts idle without a fixed-plan editor or execution controls", async () => {
  const b = backend(),
    tree = await mount(b.rpc);
  try {
    assert.equal(tree.root.findAllByType("textarea").length, 0);
    for (const node of tree.root.findAllByType("button"))
      assert(!/launch|step|预览|确认执行|添加/.test(text(node)));
    assert.match(rendered(tree), /当前没有调查/);
    assert.match(rendered(tree), /在对话中/);
    forbidden(b.calls);
    assert.deepEqual(
      [...new Set(b.calls.map((c) => c.action))].sort(),
      ["capabilities", "investigation", "listJobs"],
    );
  } finally {
    await unmount(tree);
  }
});

test("VS discovery does not connect until the selected instance is explicitly connected", async () => {
  const b = backend(),
    tree = await mount(b.rpc);
  try {
    await selectConnection(tree);
    assert(!b.calls.some((c) => c.action === "connect"));
    await click(tree, "明确连接所选实例");
    const c = b.calls.find((c) => c.action === "connect");
    assert.deepEqual(JSON.parse(JSON.stringify(c.args)), {
      instanceId: "vs",
      solutionPath: "G:/workspace/app.sln",
    });
    assert(b.calls.find((c) => c.action === "capabilities"));
    assert.match(rendered(tree), /后台报告已连接/);
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("capability version and dynamic feature gates reject stale backends before connect", async () => {
  for (const caps of [
    { version: "0.1.2", protocol: 1, features: { dynamicDebug: true } },
    { version: "0.1.4", protocol: 1 },
  ]) {
    const b = backend({ capabilities: () => caps }),
      tree = await mount(b.rpc);
    try {
      await selectConnection(tree);
      await click(tree, "明确连接所选实例");
      assert(!b.calls.some((c) => c.action === "connect"));
      assert.match(rendered(tree), /前后端协议不匹配/);
      for (const label of [
        "刷新调查",
        "停止 AI 后续调试 / 手动接管",
        "读取只读快照",
      ])
        await click(tree, label);
      assert(
        !b.calls.some((c) =>
          ["investigation", "takeover", "snapshot", "connect"].includes(
            c.action,
          ),
        ),
      );
    } finally {
      await unmount(tree);
    }
  }
});

test("investigation fields and last job results are rendered as evidence", async () => {
  const b = backend({
    investigation: () => ({
      investigationId: "inv",
      status: "active",
      goal: "startup crash",
      target: { instanceId: "vs" },
      budget: { maxCalls: 64 },
      actionsUsed: 2,
      lastJobId: "evidence",
      history: [{ jobId: "evidence", action: "snapshot", status: "completed" }],
    }),
    jobStatus: () => ({
      jobId: "evidence",
      status: "completed",
      results: [{ observation: "access violation" }],
    }),
  });
  const tree = await mount(b.rpc);
  try {
    for (const value of [
      "startup crash",
      "active",
      "maxCalls",
      "64",
      "snapshot",
      "access violation",
    ])
      assert(rendered(tree).includes(value), value);
    assert.equal(
      b.calls.find((c) => c.action === "jobStatus").args.jobId,
      "evidence",
    );
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("takeover revokes current investigation without debugger pause or termination RPC", async () => {
  let revoked = false;
  const b = backend({
    investigation: () => ({ status: revoked ? "revoked" : "active" }),
    takeover: () => {
      revoked = true;
      return { status: "revoked" };
    },
  });
  const tree = await mount(b.rpc);
  try {
    await click(tree, "停止 AI 后续调试 / 手动接管");
    assert.equal(b.calls.filter((c) => c.action === "takeover").length, 1);
    assert.equal(
      Object.keys(b.calls.find((c) => c.action === "takeover").args).length,
      0,
    );
    assert.match(rendered(tree), /不是暂停或终止目标进程/);
    assert(
      !b.calls.some((c) =>
        ["pause", "stop", "terminate", "disconnect"].includes(c.action),
      ),
    );
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("task restoration preserves correlation identity and permits cancellation", async () => {
  const jobs = createJobStore();
  jobs.set(sessionKey(session), {
    jobId: "",
    job: null,
    unknown: true,
    requestId: "req",
  });
  const b = backend({
    listJobs: () => ({
      jobs: [
        {
          jobId: "job",
          requestId: "req",
          status: "running",
          owner: { cwd: "G:/old" },
        },
      ],
      hasMore: false,
    }),
  });
  const tree = await mount(b.rpc, jobs);
  try {
    assert.equal(
      b.calls.find((c) => c.action === "listJobs").args.requestId,
      "req",
    );
    assert.equal(jobs.get(sessionKey(session)).jobId, "job");
    await click(tree, "请求取消任务");
    assert.equal(b.calls.find((c) => c.action === "cancel").args.jobId, "job");
    assert.match(rendered(tree), /不证明目标进程停止/);
    assert.equal(jobs.get(sessionKey(session)).unknown, false);
    assert.match(rendered(tree), /取消请求已返回终态/);
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("unresolved request recovery does not adopt a different same-cwd job", async () => {
  const jobs = createJobStore();
  jobs.set(sessionKey(session), {
    jobId: "",
    job: null,
    unknown: true,
    requestId: "missing",
  });
  const b = backend({
    listJobs: () => ({
      jobs: [
        {
          jobId: "other",
          requestId: "other",
          status: "succeeded",
          owner: { cwd: session.cwd },
        },
      ],
      hasMore: false,
    }),
  });
  const tree = await mount(b.rpc, jobs);
  try {
    assert.equal(jobs.get(sessionKey(session)).jobId, "");
    assert.equal(jobs.get(sessionKey(session)).unknown, true);
    assert.match(rendered(tree), /不证明原请求未执行/);
    assert.equal(
      tree.root.findAllByType("input").at(-1).props.value,
      "",
    );
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("investigation completion remains a self-reported status", async () => {
  const b = backend({
      investigation: () => ({
        status: "succeeded",
        goal: "observe",
        investigationId: "inv",
      }),
    }),
    tree = await mount(b.rpc);
  try {
    assert.match(rendered(tree), /succeeded（后台自报，非独立验收）/);
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("external store subscriptions update a remounted observer without submitting work", async () => {
  const jobs = createJobStore(),
    b = backend();
  let tree = await mount(b.rpc, jobs);
  await unmount(tree);
  tree = await mount(b.rpc, jobs);
  try {
    await act(async () =>
      jobs.set(sessionKey(session), {
        jobId: "late-job",
        job: { status: "completed", results: ["late evidence"] },
        requestId: "r",
        unknown: false,
      }),
    );
    assert.match(rendered(tree), /late evidence/);
    assert.equal(
      tree.root.findAllByType("input").at(-1).props.value,
      "late-job",
    );
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("read-only snapshot displays actual frames and unavailable investigation is not success", async () => {
  const b = backend({
      investigation: () => {
        throw new Error("offline");
      },
    }),
    tree = await mount(b.rpc);
  try {
    assert.match(rendered(tree), /调查观察中断/);
    await click(tree, "读取只读快照");
    assert.match(rendered(tree), /main.cpp:42/);
    forbidden(b.calls);
  } finally {
    await unmount(tree);
  }
});

test("unmount aborts pending investigation observation and late result cannot leak", async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const b = backend({ investigation: () => pending }),
    tree = await mount(b.rpc);
  const signal = b.calls.find((c) => c.action === "investigation").signal;
  await unmount(tree);
  assert.equal(signal.aborted, true);
  await act(async () => {
    resolve({ status: "active", goal: "late" });
    await pending;
  });
  forbidden(b.calls);
});
