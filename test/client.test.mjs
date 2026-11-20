import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const compiled = await build({ entryPoints: [fileURLToPath(new URL('src/client/protocol.ts', root))], bundle: true, platform: 'node', format: 'esm', write: false });
const protocol = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const { parsePlan, createRpc, terminalJob, RpcError, pretty, errorText } = protocol;

test('parsePlan accepts bounded JSON plans and preserves explicit params', () => {
  const steps = [{ action: 'snapshot', params: {} }, { action: 'step', params: { kind: 'over' } }];
  assert.deepEqual(parsePlan(JSON.stringify(steps), 2, 1000), { steps, maxSteps: 2, timeoutMs: 1000 });
  assert.equal(parsePlan(JSON.stringify([steps[0]]), 32, 300000).maxSteps, 32);
});

test('parsePlan rejects malformed JSON, shapes, extra fields and budgets', () => {
  const good = '[{"action":"snapshot","params":{}}]';
  for (const text of ['{', '{}', '[]', '[null]', '[{}]', '[{"action":" ","params":{}}]', '[{"action":"snapshot","params":null}]', '[{"action":"snapshot","params":[]}]', '[{"action":"snapshot","params":{},"confirmed":true}]']) {
    assert.throws(() => parsePlan(text, 8, 30000), undefined, text);
  }
  for (const value of [0, 33, 1.5, NaN, Infinity, '8']) assert.throws(() => parsePlan(good, value, 30000));
  for (const value of [999, 300001, 1000.5, NaN, Infinity, '1000']) assert.throws(() => parsePlan(good, 8, value));
  assert.throws(() => parsePlan('[{"action":"snapshot","params":{}},{"action":"snapshot","params":{}}]', 1, 30000));
});

test('RPC uses host endpoint and flat session-bound payload, forwarding cancellation', async () => {
  const calls = [], signal = new AbortController().signal;
  const rpc = createRpc({ rpc: { async call(...args) { calls.push(args); return { ok: true, value: { jobId: 'j', status: 'queued' } }; } } });
  assert.deepEqual(await rpc('execute', 'session-a', { previewId: 'p', confirmed: true }, signal), { jobId: 'j', status: 'queued' });
  assert.deepEqual(calls, [['/auto-debug-rpc', 'execute', { sessionId: 'session-a', previewId: 'p', confirmed: true }, signal]]);
  await rpc('capabilities', 'session-a');
  assert.deepEqual(calls[1][2], { sessionId: 'session-a' });
});

test('RPC rejects backend errors and invalid envelopes without retrying transport', async () => {
  for (const envelope of [null, undefined, {}, { ok: 'true' }]) {
    await assert.rejects(createRpc({ rpc: { call: async () => envelope } })('status', 'a'), { code: 'INVALID_ENVELOPE' });
  }
  await assert.rejects(createRpc({ rpc: { call: async () => ({ ok: false, error: { code: 'FOREIGN_JOB', message: 'denied' } }) } })('jobStatus', 'a'), { code: 'FOREIGN_JOB', message: 'denied' });
  await assert.rejects(createRpc({ rpc: { call: async () => ({ ok: false }) } })('status', 'a'), { code: 'UNAVAILABLE' });
  let calls = 0;
  const failure = new Error('response lost');
  await assert.rejects(createRpc({ rpc: { async call() { calls++; throw failure; } } })('execute', 'a'), error => error === failure);
  assert.equal(calls, 1, 'unknown mutation outcome must not replay');
});

test('terminal detection distinguishes pending jobs from unknown and interrupted outcomes', () => {
  for (const state of ['succeeded', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']) {
    assert.equal(terminalJob({ state }), true, state);
    assert.equal(terminalJob({ status: state }), true, state);
  }
  for (const state of ['queued', 'running', 'cancelling', '', 'future-state']) assert.equal(terminalJob({ status: state }), false);
  assert.equal(terminalJob(null), false);
  assert.equal(terminalJob({ state: 'running', status: 'completed' }), false);
  assert.equal(errorText(new RpcError('BUSY', 'occupied')), '[BUSY] occupied');
  assert.equal(pretty(undefined), '未提供');
});

test('built ModuleLoader artifact registers main and sidebar slots without making RPC calls', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const artifact = await readFile(new URL('dist/client.js', root), 'utf8');
  const require = createRequire(import.meta.url), modules = [], dependencies = [];
  vm.runInNewContext(artifact, { window: { __ModuleLoader__: { load: value => modules.push(value) } } }, { timeout: 1000 });
  assert.equal(modules.length, 1);
  assert.equal(modules[0].id, pkg.name);
  const exports = modules[0].factory(name => { dependencies.push(name); assert.equal(name, 'react', 'host only guarantees the shared React module'); return require(name); });
  assert.deepEqual([...exports.default.inject], ['slots', 'connection']);
  assert.equal(exports.default.name, pkg.name);
  const registrations = [], injections = [];
  exports.default.apply({
    connection: { rpc: { call() { assert.fail('registration must not perform RPC or start debugging'); } } },
    slots: {
      inject(name, callback) { injections.push(name); callback(); },
      register(meta, component) { registrations.push({ meta, component }); return () => {}; },
    },
  });
  assert.deepEqual(injections, ['main', 'sidebar.panellist', 'main', 'sidebar.panellist']);
  assert.equal(registrations.find(x => x.meta.key === 'auto-debug').meta.name, 'main');
  assert.equal(registrations.find(x => x.meta.id === 'auto-debug').meta.label(), '自动调试');
  const performance = registrations.find(x => x.meta.key === 'auto-debug-profiler');
  assert.equal(performance.meta.name, 'main');
  const scroll = performance.component({ useSessions: select => select({ byId: {} }) });
  assert.equal(scroll.props.className, 'ad-profiler-scroll');
  assert.equal(scroll.props.tabIndex, 0);
  assert.equal(scroll.props.role, 'region');
  assert.equal(registrations.find(x => x.meta.id === 'auto-debug-profiler').meta.label(), '性能分析');
  assert(registrations.every(row => typeof row.component === 'function'));
  assert.deepEqual([...new Set(dependencies)], ['react']);
});
