import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { build } from "esbuild";
import React from "react";
import { create, act } from "react-test-renderer";

// Actual React reconciler, effects, subscriptions, cleanup and remount; no DOM or VS.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
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
const storage = new Map();
vm.runInNewContext(compiled.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  crypto: globalThis.crypto,
  sessionStorage: {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
});
const { Panel, createJobStore, sessionKey } = module.exports;
const session = { id: "session", cwd: "G:/workspace" };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const text = (node) =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const button = (tree, label) =>
  tree.root.findAllByType("button").find((node) => text(node) === label);
async function click(tree, label) {
  const node = button(tree, label);
  assert(node, label);
  assert(!node.props.disabled, label + " enabled");
  await act(async () => {
    node.props.onClick();
  });
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
function backend(overrides = {}) {
  const calls = [];
  const rpc = async (action, id, args = {}) => {
    calls.push({ action, id, args });
    if (overrides[action]) return overrides[action](args);
    return {
      listJobs: { jobs: [], total: 0, hasMore: false },
      capabilities: { version: "0.1.1", protocol: 1 },
      status: { state: "connected", target: { instanceId: "vs" } },
      discover: { instances: [{ instanceId: "vs" }] },
      connect: {},
      preview: { previewId: "preview", expiresAt: Date.now() + 60000 },
      cancel: { jobId: "job", status: "cancelling" },
    }[action];
  };
  return { rpc, calls };
}
async function prepare(tree) {
  await click(tree, "发现实例");
  await act(async () => {
    tree.root
      .findAllByType("select")[0]
      .props.onChange({ target: { value: "vs" } });
    tree.root
      .findAllByType("input")
      .find((n) => n.props.placeholder)
      .props.onChange({ target: { value: "G:/workspace/project.sln" } });
  });
  await click(tree, "明确连接所选实例");
  await click(tree, "预览计划（不执行）");
  await act(async () =>
    tree.root
      .findByProps({ type: "checkbox" })
      .props.onChange({ target: { checked: true } }),
  );
}

test("pending execute settles into replacement Panel via live external-store subscription", async () => {
  storage.clear();
  const pending = deferred();
  const jobs = createJobStore();
  const b = backend({ execute: () => pending.promise });
  let tree = await mount(b.rpc, jobs);
  await prepare(tree);
  await click(tree, "确认并执行此预览");
  const sent = b.calls.find((c) => c.action === "execute");
  assert.equal(sent.args.confirmed, true);
  assert.match(sent.args.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(jobs.get(sessionKey(session)).unknown, true);
  await unmount(tree);
  tree = await mount(b.rpc, jobs);
  assert.equal(button(tree, "查询任务进度").props.disabled, true);
  await act(async () => pending.resolve({ jobId: "job", status: "running" }));
  assert.equal(button(tree, "查询任务进度").props.disabled, false);
  assert.equal(
    tree.root.findAllByType("input").find((n) => n.props.value === "job").props
      .value,
    "job",
  );
  assert.equal(b.calls.filter((c) => c.action === "execute").length, 1);
  await click(tree, "请求取消任务");
  assert.equal(jobs.get(sessionKey(session)).unknown, true);
  assert.equal(jobs.get(sessionKey(session)).job.status, "cancelling");
  await unmount(tree);
});

test("lost response reload restores same request from backend without repeating mutation", async () => {
  storage.clear();
  const jobs = createJobStore();
  const b = backend({
    execute: () => {
      throw new Error("lost response");
    },
  });
  let tree = await mount(b.rpc, jobs);
  await prepare(tree);
  await click(tree, "确认并执行此预览");
  const requestId = jobs.get(sessionKey(session)).requestId;
  await unmount(tree);
  const fresh = createJobStore();
  const recovery = backend({
    listJobs: (args) => {
      assert.equal(args.requestId, requestId);
      return {
        jobs: [
          { jobId: "original", requestId, status: "succeeded", owner: session },
        ],
        total: 1,
        hasMore: false,
      };
    },
  });
  tree = await mount(recovery.rpc, fresh);
  assert.equal(fresh.get(sessionKey(session)).jobId, "original");
  assert.equal(button(tree, "查询任务进度").props.disabled, false);
  assert.equal(recovery.calls.filter((c) => c.action === "execute").length, 0);
  await unmount(tree);
});

test("session plus cwd isolation and query-only recovery of previous cwd jobs", async () => {
  storage.clear();
  const jobs = createJobStore();
  jobs.set(sessionKey(session), {
    jobId: "old",
    job: { jobId: "old", status: "running", owner: session },
    unknown: false,
    requestId: "old-request",
  });
  const other = { ...session, cwd: "G:/other" };
  const b = backend({
    listJobs: () => ({
      jobs: [{ jobId: "old", status: "running", owner: session }],
      total: 1,
      hasMore: false,
    }),
    jobStatus: () => ({ jobId: "old", status: "succeeded", owner: session }),
  });
  const tree = await mount(b.rpc, jobs, other);
  assert.equal(jobs.get(sessionKey(other)).jobId, "");
  await act(async () =>
    tree.root
      .findAllByType("select")[1]
      .props.onChange({ target: { value: "old" } }),
  );
  await click(tree, "查询任务进度");
  assert.equal(button(tree, "预览计划（不执行）").props.disabled, true);
  assert.equal(jobs.get(sessionKey(session)).jobId, "old");
  await unmount(tree);
});

test("handshake mismatch fails closed before connect preview and execute; errors release flow lock", async () => {
  for (const gate of ["connect", "preview", "execute"]) {
    storage.clear();
    let version = "0.1.1";
    const b = backend({ capabilities: () => ({ version, protocol: 1 }) });
    const tree = await mount(b.rpc);
    await click(tree, "发现实例");
    await act(async () => {
      tree.root
        .findAllByType("select")[0]
        .props.onChange({ target: { value: "vs" } });
      tree.root
        .findAllByType("input")
        .find((n) => n.props.placeholder)
        .props.onChange({ target: { value: "G:/project.sln" } });
    });
    if (gate !== "connect") await click(tree, "明确连接所选实例");
    if (gate === "execute") {
      await click(tree, "预览计划（不执行）");
      await act(async () =>
        tree.root
          .findByProps({ type: "checkbox" })
          .props.onChange({ target: { checked: true } }),
      );
    }
    version = "0.1.0";
    await click(
      tree,
      gate === "connect"
        ? "明确连接所选实例"
        : gate === "preview"
          ? "预览计划（不执行）"
          : "确认并执行此预览",
    );
    assert.equal(b.calls.filter((c) => c.action === gate).length, 0);
    assert.equal(button(tree, "读取能力声明").props.disabled, false);
    assert.match(JSON.stringify(tree.toJSON()), /协议不匹配/);
    await unmount(tree);
  }
});

test("hung execute allows explicit UI wait release and original-task recovery without replay", async () => {
  storage.clear();
  const pending = deferred();
  let submitted;
  const b = backend({
    execute: (args) => {
      submitted = args;
      return pending.promise;
    },
    listJobs: () => ({
      jobs: submitted
        ? [
            {
              jobId: "original",
              requestId: submitted.requestId,
              status: "running",
              owner: session,
            },
          ]
        : [],
      total: submitted ? 1 : 0,
      hasMore: false,
    }),
  });
  const jobs = createJobStore();
  const tree = await mount(b.rpc, jobs);
  await prepare(tree);
  await click(tree, "确认并执行此预览");
  await click(tree, "停止界面等待并查询原任务（不取消执行）");
  await click(tree, "从后台恢复会话任务");
  assert.equal(button(tree, "查询任务进度").props.disabled, false);
  assert.equal(button(tree, "请求取消任务").props.disabled, false);
  assert.equal(b.calls.filter((c) => c.action === "execute").length, 1);
  await act(async () =>
    pending.resolve({ jobId: "original", status: "running" }),
  );
  await unmount(tree);
});

test("bounded backend task pages remain explicitly navigable", async () => {
  storage.clear();
  const b = backend({
    listJobs: (args) => ({
      jobs: [
        {
          jobId: "page-" + args.offset,
          status: "succeeded",
          owner: { id: "session", cwd: "G:/previous" },
        },
      ],
      total: 51,
      offset: args.offset,
      limit: args.limit,
      hasMore: args.offset === 0,
    }),
  });
  const tree = await mount(b.rpc);
  await click(tree, "下一页任务");
  assert.deepEqual(
    b.calls.filter((c) => c.action === "listJobs").map((c) => c.args.offset),
    [0, 50],
  );
  assert(
    b.calls
      .filter((c) => c.action === "listJobs")
      .every((c) => c.args.limit === 50),
  );
  assert.equal(button(tree, "下一页任务").props.disabled, true);
  await unmount(tree);
});

test("persistence failure stays blocked until explicit disconnect recovery", async () => {
  storage.clear();
  const jobs = createJobStore();
  jobs.set(sessionKey(session), {
    jobId: "failed-save",
    job: { jobId: "failed-save", status: "persistence_failed", owner: session },
    unknown: true,
    requestId: "request",
  });
  const b = backend();
  const tree = await mount(b.rpc, jobs);
  assert.equal(button(tree, "预览计划（不执行）").props.disabled, true);
  await click(tree, "已核对 VS，明确断开旧连接以恢复流程");
  assert.equal(jobs.get(sessionKey(session)).unknown, false);
  assert.equal(b.calls.filter((c) => c.action === "disconnect").length, 1);
  await unmount(tree);
});
test("recovered persistence failure cannot be downgraded by same-request delayed execute response", async () => {
  storage.clear();
  const pending = deferred();
  let submitted;
  const b = backend({
    execute: (args) => {
      submitted = args;
      return pending.promise;
    },
    listJobs: () => ({
      jobs: submitted
        ? [
            {
              jobId: "original",
              requestId: submitted.requestId,
              status: "persistence_failed",
              owner: session,
            },
          ]
        : [],
      total: submitted ? 1 : 0,
      hasMore: false,
    }),
  });
  const jobs = createJobStore();
  const tree = await mount(b.rpc, jobs);
  await prepare(tree);
  await click(tree, "确认并执行此预览");
  await click(tree, "停止界面等待并查询原任务（不取消执行）");
  await click(tree, "从后台恢复会话任务");
  assert.equal(button(tree, "查询任务进度").props.disabled, false);
  assert.equal(button(tree, "请求取消任务").props.disabled, true);
  assert.equal(b.calls.filter((c) => c.action === "execute").length, 1);
  await act(async () =>
    pending.resolve({ jobId: "original", status: "running" }),
  );
  assert.equal(jobs.get(sessionKey(session)).job.status, "persistence_failed");
  assert.equal(jobs.get(sessionKey(session)).unknown, true);
  assert.equal(button(tree, "预览计划（不执行）").props.disabled, true);
  await unmount(tree);
});

test("storageUnavailable and incomplete recovery warnings are rendered", async () => {
  for (const flags of [{ storageUnavailable: true }, { incomplete: true }]) {
    storage.clear();
    const b = backend({ listJobs: () => ({ jobs: [], total: 0, ...flags }) });
    const tree = await mount(b.rpc);
    assert.match(
      JSON.stringify(tree.toJSON()),
      /后台任务存储不可用或列表不完整/,
    );
    assert.match(JSON.stringify(tree.toJSON()), /未列出任务不证明未执行/);
    await unmount(tree);
  }
});
