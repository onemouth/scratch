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

test('removed HTTP wait routes return 404 without changing agents', async () => {
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

});

test('retired HTTP callbacks and TTY messaging return 404; HTTP progress is rejected atomically', async () => {
  const { app, children, agent, request } = await fixture();
  try {
    for (const id of [agent.id, 'missing']) for (const kind of ['activity', 'session']) {
      const response = await request(`/agents/${id}/${kind}`, 'POST', { state: 'working', sessionFile: null, sessionId: 'ignored', seq: 100 });
      assert.equal(response.status, 404);
    }
    assert.equal((await request('/messages', 'POST', { toId: agent.id, text: 'Must not enter TTY' })).status, 404);
    const before = (await request(`/agents/${agent.id}`)).body;
    assert.equal((await request(`/agents/${agent.id}`, 'PATCH', { note: 'HTTP disabled', name: 'Do not apply', x: 9999 })).status, 400);
    assert.deepEqual((await request(`/agents/${agent.id}`)).body, before);
    assert.equal(before.activity, 'unknown'); assert.equal(before.note, '');
    assert.equal(app.runtime.reportSession, undefined); assert.equal(app.runtime.reportActivity, undefined);
    for (const env of ['AGENT_CANVAS_RUN', 'AGENT_CANVAS_TELEMETRY_TRANSPORT', 'AGENT_CANVAS_SHARED_MEMORY']) assert.equal(children[0].options.env[env], undefined);
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
