import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './index.js';

async function fixture(options = {}) {
  const children = [];
  const app = createApp({ port: 0, ...options, spawnAgent: (_bin, args, options) => {
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
  return { app, children, agent, base, request };
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

test('removed HTTP wait routes return 404 without changing agents, including HTTP-only mode', async () => {
  const { app, agent, request } = await fixture();
  try {
    for (const method of ['POST', 'GET']) {
      for (const id of [agent.id, 'missing']) {
        const response = await request(`/agents/${id}/wait`, method, method === 'POST' ? { timeoutMs: 600000 } : undefined);
        assert.equal(response.status, 404);
        assert.equal(typeof response.body.error, 'string');
      }
    }
    assert.equal((await request(`/agents/${agent.id}`)).body.status, 'running');
    assert.equal('wait' in app.runtime, false);
    assert.equal('waiterCount' in app.runtime, false);
    const denied = await request(`/agents/${agent.id}/wait`, 'POST', {}, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403);
  } finally { await app.close(); }
  const httpOnly = createApp({ port: 0, sharedMemory: false });
  try {
    await httpOnly.listen();
    const response = await fetch(`http://127.0.0.1:${httpOnly.server.address().port}/api/agents/missing/wait`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404);
  } finally { await httpOnly.close(); }
});

test('HTTP-only activity reports still reject stale sequences and replaced process tokens without HTTP wait', async () => {
  const { app, children, agent, request } = await fixture({ sharedMemory: false });
  try {
    const oldToken = children[0].options.env.AGENT_CANVAS_RUN;
    const report = (state, seq, runToken = oldToken) => request(`/agents/${agent.id}/activity`, 'POST', { runToken, state, seq });
    await report('working', 10); await report('idle', 9);
    assert.equal((await request(`/agents/${agent.id}`)).body.activity, 'working');
    await report('idle', 11); await report('working', 10);
    assert.equal((await request(`/agents/${agent.id}`)).body.activity, 'idle');
    await request(`/agents/${agent.id}/stop`, 'POST', {});
    await request(`/agents/${agent.id}/resume`, 'POST', {});
    assert.equal((await report('idle', 12)).status, 409);
    assert.equal((await request(`/agents/${agent.id}`)).body.activity, 'unknown');
    const newToken = children[1].options.env.AGENT_CANVAS_RUN;
    assert.equal((await report('working', 1, newToken)).status, 200);
    assert.equal((await request(`/agents/${agent.id}`)).body.activity, 'working');
    const session = (sessionId, seq) => request(`/agents/${agent.id}/session`, 'POST', { runToken: newToken, sessionFile: null, sessionId, seq });
    assert.equal((await session('newer', 10)).status, 200);
    assert.equal((await session('late-older', 9)).status, 200);
    assert.equal((await request(`/agents/${agent.id}`)).body.sessionId, 'newer');
    assert.equal((await session('unsequenced', undefined)).status, 400);
  } finally { await app.close(); }
});

test('actual curl receives 404 for removed wait instead of opening a long poll', async () => {
  const { app, agent, base } = await fixture();
  try {
    const { stdout } = await promisify(execFile)('curl', ['-sS', '--max-time', '3', '-w', '\\n%{http_code}', '-X', 'POST',
      `${base}/agents/${agent.id}/wait`, '-H', 'Content-Type: application/json', '-d', '{"timeoutMs":600000}']);
    const newline = stdout.lastIndexOf('\n');
    assert.equal(stdout.slice(newline + 1), '404');
    assert.equal(typeof JSON.parse(stdout.slice(0, newline)).error, 'string');
  } finally { await app.close(); }
});
