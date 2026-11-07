import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './index.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('Timed out waiting for fixture state');
}
async function fixture() {
  const children = [];
  const app = createApp({ port: 0, spawnAgent: (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write() {}, resize() {}, kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, method = 'GET', body, options = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(options.signal ? { signal: options.signal } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const agent = (await request('/agents', 'POST', { name: 'Query fixture', workdir: process.cwd() })).body;
  const report = (state, seq, runToken = children.at(-1).options.env.AGENT_CANVAS_RUN) => request(`/agents/${agent.id}/activity`, 'POST', { runToken, state, seq });
  const wait = (body = {}, options) => request(`/agents/${agent.id}/wait`, 'POST', body, options);
  return { app, children, agent, base, request, report, wait };
}

test('HTTP metadata queries omit terminal output and interactive source; dedicated reads retain the bounded ANSI tail', async () => {
  const { app, children, agent, request, base } = await fixture();
  try {
    const output = '\x1b[32m' + 'TERMINAL_ONLY_MARKER'.repeat(5000) + '\x1b[0m';
    children[0].emit('data', output);
    const card = (await request('/cards', 'POST', { type: 'interactive', title: 'Query source', html: '<svg></svg>', javascript: '/* SOURCE_ONLY_MARKER */', place: false })).body;
    for (const path of ['/state', '/agents', `/agents/${agent.id}`]) {
      const res = await request(path);
      assert.equal(res.status, 200);
      const agents = res.body.agents ?? [res.body];
      assert.equal(agents[0].id, agent.id); assert.equal(Object.hasOwn(agents[0], 'output'), false);
      assert.ok(!JSON.stringify(res.body).includes('TERMINAL_ONLY_MARKER'));
      assert.ok(!JSON.stringify(res.body).includes('SOURCE_ONLY_MARKER'));
    }
    const read = await request(`/agents/${agent.id}/output`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { id: agent.id, output: output.slice(-80000), maxCharacters: 80000 });
    assert.equal((await request(`/cards/${card.id}`)).body.interactive.javascript, '/* SOURCE_ONLY_MARKER */');
    assert.equal((await request('/cards')).body.cards[0].interactive.javascript, undefined);
    // Browser SSE remains compatible: initial output replay shape is unchanged.
    const stream = await fetch(base + '/events');
    const reader = stream.body.getReader(); let text = '';
    try {
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
      const snapshot = JSON.parse(text.slice(6, text.indexOf('\n\n')));
      assert.equal(snapshot.agents[0].output, output.slice(-80000));
    } finally { await reader.cancel(); }
    await request(`/agents/${agent.id}/stop`, 'POST', {});
    assert.match((await request(`/agents/${agent.id}/output`)).body.output, /Pi exited/);
    for (const path of ['/agents/missing', '/agents/missing/output']) {
      const res = await request(path); assert.equal(res.status, 404); assert.equal(typeof res.body.error, 'string');
    }
  } finally { await app.close(); }
});

test('HTTP waits return idle immediately, wait through unknown, validate input and preserve flat error responses', async () => {
  const { app, agent, request, report, wait } = await fixture();
  try {
    const timeout = await wait({ timeoutMs: 10 });
    assert.equal(timeout.status, 200);
    assert.deepEqual(timeout.body, { id: agent.id, reason: 'timeout', status: 'running', activity: 'unknown' });
    for (const timeoutMs of [0, -1, 1.5, '10', null, 600001]) assert.equal((await wait({ timeoutMs })).status, 400);
    assert.equal((await wait({ extra: true })).status, 400);
    assert.equal((await request('/agents/missing/wait', 'POST', {})).status, 404);
    await report('idle', 1);
    assert.deepEqual((await wait()).body, { id: agent.id, reason: 'idle', status: 'running', activity: 'idle' });
    const denied = await wait({}, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403); assert.equal(typeof denied.body.error, 'string');
    assert.equal(app.runtime.waiterCount, 0);
  } finally { await app.close(); }
});

test('HTTP waits observe fast turns and ignore stale activity independently of SSE coalescing', async () => {
  const { app, report, wait } = await fixture();
  try {
    await report('working', 1);
    const first = wait(); await until(() => app.runtime.waiterCount === 1);
    await report('idle', 2); await report('working', 3);
    assert.equal((await first).body.reason, 'idle');
    const second = wait(); await until(() => app.runtime.waiterCount === 1);
    await report('idle', 2); assert.equal(app.runtime.waiterCount, 1);
    await report('idle', 4); assert.equal((await second).body.reason, 'idle');
    assert.equal(app.runtime.waiterCount, 0);
  } finally { await app.close(); }
});

test('HTTP wait pins the old run through Stop/Resume; timeout and disconnect never stop the target', async () => {
  const { app, children, agent, request, report, wait } = await fixture();
  try {
    const oldToken = children[0].options.env.AGENT_CANVAS_RUN;
    await report('working', 1);
    const pending = wait(); await until(() => app.runtime.waiterCount === 1);
    await request(`/agents/${agent.id}/stop`, 'POST', {});
    await request(`/agents/${agent.id}/resume`, 'POST', {});
    assert.equal((await pending).body.reason, 'stopped');
    assert.equal((await report('idle', 2, oldToken)).status, 409);
    assert.equal((await wait({ timeoutMs: 10 })).body.activity, 'unknown');
    const controller = new AbortController();
    const disconnected = wait({}, { signal: controller.signal });
    await until(() => app.runtime.waiterCount === 1); controller.abort();
    await assert.rejects(disconnected, { name: 'AbortError' });
    await until(() => app.runtime.waiterCount === 0);
    assert.equal((await request(`/agents/${agent.id}`)).body.status, 'running');
    await request(`/agents/${agent.id}/stop`, 'POST', {});
    assert.equal((await wait()).body.reason, 'stopped');
  } finally { await app.close(); }
});

test('multiple HTTP callers wait independently; server shutdown releases pending waits', async () => {
  const { app, report, wait } = await fixture();
  try {
    await report('working', 1);
    const controller = new AbortController();
    const canceled = wait({}, { signal: controller.signal }), one = wait(), two = wait();
    await until(() => app.runtime.waiterCount === 3); controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    await until(() => app.runtime.waiterCount === 2);
    await report('idle', 2);
    assert.equal((await one).body.reason, 'idle'); assert.equal((await two).body.reason, 'idle');
    await report('working', 3);
    const pending = wait(); await until(() => app.runtime.waiterCount === 1);
    const closing = app.close();
    const res = await pending; assert.equal(res.status, 503); assert.equal(typeof res.body.error, 'string');
    await closing; assert.equal(app.runtime.waiterCount, 0);
  } finally { await app.close(); }
});

test('actual curl can wait for a turn without special EOF handling', async () => {
  const { app, agent, base, report } = await fixture();
  try {
    await report('working', 1);
    const curl = promisify(execFile)('curl', ['-fsS', '--max-time', '3', '-X', 'POST', `${base}/agents/${agent.id}/wait`, '-H', 'Content-Type: application/json', '-d', '{"timeoutMs":2000}']);
    await until(() => app.runtime.waiterCount === 1);
    await report('idle', 2);
    assert.equal(JSON.parse((await curl).stdout).reason, 'idle');
  } finally { await app.close(); }
});
