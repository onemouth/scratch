import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { memoryName } from '../shared/canvas-memory.js';
import { createCanvasMemory } from './canvas-memory.js';
import { createCanvasQueries } from './canvas-queries.js';
import { createCanvasQueryClient } from './canvas-query-client.js';
import { queryPage, QUERY_SLOTS, validateQuery, validateQueryFrame } from '../shared/canvas-queries.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { createApp } from './index.js';
import { CanvasLayout } from './canvas-layout.js';
import { queryFixture } from '../scripts/tests/query-fixture.js';
import queryExtension, { bindQueryProcess, detachQueryProcess } from './pi-canvas-queries.js';

function fixture({ execute = (_id, _generation, kind, params) => ({ kind, params }), timeoutMs = 1000, initiallyStale = false, autoDrain = true } = {}) {
  const memory = createCanvasMemory({ getState: () => ({ agents: [], notes: [], edges: [], cards: [], cardPlacements: [] }) });
  const errors = [], native = messagingNative();
  const silentNative = Object.create(native);
  Object.defineProperty(silentNative, 'signalWatch', { value: name => native.signalOpen(name) });
  const service = createCanvasQueries({ epoch: memory.epoch, execute, watchdogMs: 60000,
    native: autoDrain ? native : silentNative, onError: error => errors.push(error) });
  const channel = service.createChannel('query-agent', randomUUID());
  let readError = initiallyStale ? 'SHM_STALE' : null;
  const client = createCanvasQueryClient({ config: channel.config, name: memory.name, epoch: memory.epoch, timeoutMs, watchdogMs: autoDrain ? 20 : 60000,
    open: () => ({ read() { if (readError) throw Object.assign(new Error('Fixture memory error'), { code: readError }); }, close() {} }) });
  return { memory, service, channel, client, native, errors, setError: code => { readError = code; },
    close() { client.close(); service.close(); memory.close(); } };
}

test('query schema is strict, read-only and deadline bounded; paging preserves complete Unicode records', () => {
  for (const [kind, params] of [['state', {}], ['PATCH', {}], ['agents', { output: true }], ['agents', { limit: 101 }], ['layout', { offset: -1 }], ['agent', { agentId: '../bad' }], ['agent', { agentId: 'ok', limit: 1 }]]) {
    assert.throws(() => validateQuery(kind, params), { code: 'QUERY_ARGUMENT' });
  }
  assert.throws(() => validateQueryFrame({ version: 1, seq: 1, kind: 'layout', params: {}, expiresAt: 100 }, 100), { code: 'QUERY_EXPIRED' });
  assert.throws(() => validateQueryFrame({ version: 1, seq: 1, kind: 'layout', params: {}, expiresAt: 20000 }, 100), { code: 'QUERY_ARGUMENT' });
  const values = Array.from({ length: 6 }, (_, id) => ({ id, task: '🧋'.repeat(4000) }));
  const page = queryPage('agents', values, { limit: 100 });
  assert.ok(page.agents.length < 6); assert.equal(page.nextOffset, page.agents.length);
  assert.equal(page.agents[0].task, values[0].task);
  assert.deepEqual(queryPage('agents', values, { offset: 100 }).agents, []);
  assert.throws(() => queryPage('agents', [{ task: 'x'.repeat(60000) }]), { code: 'QUERY_CAPACITY' });
});

test('real SHM queries correlate parallel responses, bound failures, and use independent queues', async () => {
  let samples = 0;
  const f = fixture({ execute(_id, _gen, kind) {
    if (kind === 'agent') throw Object.assign(new Error('Absent'), { status: 404 });
    return { samples: ++samples };
  } });
  try {
    const results = await Promise.all(Array.from({ length: QUERY_SLOTS }, () => f.client.query('layout')));
    assert.equal(new Set(results.map(r => r.samples)).size, QUERY_SLOTS);
    assert.equal(results[0].source, 'posix-shared-memory'); assert.equal(results[0].serverEpoch, f.memory.epoch);
    assert.ok(Date.parse(results[0].sampledAt));
    await assert.rejects(f.client.query('agent', { agentId: 'missing' }), { code: 'QUERY_NOT_FOUND' });
    await assert.rejects(f.client.query('agents', { note: 'not a mutation' }), { code: 'QUERY_ARGUMENT' });
    assert.equal(f.client.pending, 0); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('64 KiB native slots retain framing and wraparound without relaxing size bounds', () => {
  const native = messagingNative(), name = memoryName();
  assert.equal(native.queueMaxBytes, 65536);
  const producer = native.queueCreate(name, 'producer', 65536);
  let consumer;
  try {
    consumer = native.queueOpen(name, 'consumer');
    assert.throws(() => native.queuePush(producer, Buffer.alloc(65537)), { code: 'SHM_CAPACITY' });
    for (let i = 0; i < 40; i++) {
      const bytes = Buffer.alloc(65536, i);
      native.queuePush(producer, bytes);
      const entry = native.queuePeek(consumer);
      assert.deepEqual(entry.payload, bytes);
      native.queueShift(consumer, entry.sequence);
    }
    assert.equal(native.queuePeek(consumer), null);
  } finally { if (consumer) native.queueClose(consumer); native.queueClose(producer); }
});

test('source rejects expired/replayed/malformed requests before evaluation and consumes each once', () => {
  let evaluations = 0;
  const f = fixture({ autoDrain: false, execute: () => ({ evaluations: ++evaluations }) });
  const channel = f.service.createChannel('raw-query', randomUUID());
  const requests = messageQueue(f.native, f.native.queueOpen(channel.config.requests, 'producer'));
  const responses = messageQueue(f.native, f.native.queueOpen(channel.config.responses, 'consumer'));
  try {
    const ask = frame => {
      requests.push(frame); f.service.drain();
      const result = responses.peek(); if (result) responses.shift(result.sequence);
      return result?.value;
    };
    const base = { version: 1, seq: 1, kind: 'layout', params: {}, expiresAt: Date.now() - 1 };
    assert.equal(ask(base).error.code, 'QUERY_EXPIRED');
    assert.equal(ask({ ...base, expiresAt: Date.now() + 9000 }).error.code, 'QUERY_SEQUENCE');
    assert.equal(ask({ ...base, seq: 2, kind: 'PATCH', expiresAt: Date.now() + 9000 }).error.code, 'QUERY_ARGUMENT');
    assert.equal(ask({ ...base, seq: 3, params: { requesterId: 'spoof' }, expiresAt: Date.now() + 9000 }).error.code, 'QUERY_ARGUMENT');
    assert.equal(ask({ ...base, seq: 4, expiresAt: Date.now() + 9000 }).value.evaluations, 1);
    assert.equal(ask(null), undefined);
    assert.equal(evaluations, 1); assert.equal(channel.requests.used, 0);
  } finally { requests.close(); responses.close(); f.close(); }
});

test('malformed response generations fence reads without closing live process handles', async () => {
  const f = fixture({ autoDrain: false });
  try {
    const request = f.client.query('layout');
    f.channel.responses.push({ version: 1, seq: 1, ok: true, value: { source: 'posix-shared-memory', serverEpoch: randomUUID(), sampledAt: new Date().toISOString() } });
    f.client.drain();
    await assert.rejects(request, { code: 'QUERY_PROTOCOL' });
    assert.equal(f.client.fenced, true); assert.equal(f.client.closed, false);
  } finally { f.close(); }
});

test('query response capacity errors never truncate or poison the next request', async () => {
  const f = fixture({ execute: (_id, _gen, kind) => ({ text: 'x'.repeat(kind === 'agent' ? 70000 : 10) }) });
  try {
    await assert.rejects(f.client.query('agent', { agentId: 'large' }), { code: 'QUERY_CAPACITY' });
    assert.equal((await f.client.query('layout')).text.length, 10);
    assert.equal(f.client.fenced, false);
  } finally { f.close(); }
});

test('temporary query failures retain handles without replay; fatal generations fence until cleanup', async () => {
  const f = fixture({ initiallyStale: true });
  try {
    for (const code of ['SHM_STALE', 'SHM_BUSY', 'SHM_NOT_READY', 'SHM_UNAVAILABLE']) {
      f.setError(code);
      await assert.rejects(f.client.query('layout'), { code });
      assert.equal(f.client.closed, false); assert.equal(f.client.fenced, false);
      f.setError(null);
      assert.equal((await f.client.query('layout')).kind, 'layout');
    }
    f.setError('SHM_VERSION');
    await assert.rejects(f.client.query('layout'), { code: 'SHM_VERSION' });
    assert.equal(f.client.closed, false); assert.equal(f.client.fenced, true);
    f.setError(null);
    await assert.rejects(f.client.query('layout'), { code: 'QUERY_FENCED' });
  } finally { f.close(); }
  assert.equal(f.client.closed, true);
});

test('timeouts, cancellation and detach do not resend; late responses do not resolve replacement jobs', async () => {
  let executions = 0;
  const f = fixture({ autoDrain: false, timeoutMs: 30, execute: () => ({ count: ++executions }) });
  try {
    await assert.rejects(f.client.query('layout'), { code: 'QUERY_TIMEOUT' });
    assert.equal(f.channel.requests.used, 1); assert.equal(f.client.pending, 0);
    f.service.drain(); f.client.drain(); // Late response is consumed, not replayed.
    assert.equal(executions, 1); assert.equal(f.channel.responses.used, 0);
    const controller = new AbortController();
    const cancelled = f.client.query('layout', {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { code: 'QUERY_ABORTED' });
    const detached = f.client.query('layout');
    f.client.cancel();
    await assert.rejects(detached, { code: 'QUERY_CONTEXT' });
    f.service.drain(); f.client.drain();
    assert.equal(executions, 3);
    const next = f.client.query('layout');
    f.service.drain(); f.client.drain();
    assert.equal((await next).count, 4);
    assert.equal(f.channel.requests.used, 0); assert.equal(f.client.pending, 0);
  } finally { f.close(); }
});


test('response credits bound evaluation and outstanding requests; no queue overwrites', async () => {
  let evaluations = 0;
  const f = fixture({ autoDrain: false, execute: () => ({ evaluations: ++evaluations }) });
  try {
    for (let seq = 1000; seq < 1000 + QUERY_SLOTS; seq++) f.channel.responses.push({ version: 1, seq, ok: true, value: { old: true, source: 'posix-shared-memory', serverEpoch: f.memory.epoch, sampledAt: new Date().toISOString() } });
    const requests = Array.from({ length: QUERY_SLOTS }, () => f.client.query('layout'));
    await assert.rejects(f.client.query('layout'), { code: 'QUERY_LIMIT' });
    f.service.drain();
    assert.equal(evaluations, 0); assert.equal(f.channel.requests.used, QUERY_SLOTS);
    f.client.drain(); f.service.drain(); f.client.drain();
    await Promise.all(requests);
    assert.equal(evaluations, QUERY_SLOTS); assert.equal(f.client.pending, 0);
  } finally { f.close(); }
});

test('process-owned query broker survives session replacements and fences obsolete tools', async () => {
  const f = fixture(), channel = f.service.createChannel('extension-agent', randomUUID());
  const saved = Object.fromEntries(['AGENT_CANVAS_ID', 'AGENT_CANVAS_SHM_NAME', 'AGENT_CANVAS_SHM_EPOCH', 'AGENT_CANVAS_SHM_QUERIES'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { AGENT_CANVAS_ID: channel.id, AGENT_CANVAS_SHM_NAME: f.memory.name, AGENT_CANVAS_SHM_EPOCH: f.memory.epoch, AGENT_CANVAS_SHM_QUERIES: JSON.stringify(channel.config) });
  const binding = () => {
    const handlers = {}, tools = {};
    queryExtension({ on: (event, fn) => { handlers[event] = fn; }, registerTool: tool => { tools[tool.name] = tool; } });
    handlers.session_start({}, { hasUI: false });
    return { handlers, tools };
  };
  try {
    let current = binding();
    const broker = process[Symbol.for('agent-canvas.queries.process.v1')];
    for (const reason of ['reload', 'new', 'resume', 'fork']) {
      const old = current;
      const inFlight = old.tools.canvas_layout.execute('old', {});
      old.handlers.session_shutdown({ reason });
      assert.equal((await inFlight).details.code, 'QUERY_CONTEXT');
      current = binding();
      old.handlers.session_shutdown({ reason: 'quit' }); // Stale cleanup must not close current transport.
      assert.equal(process[Symbol.for('agent-canvas.queries.process.v1')], broker);
      assert.equal(broker.client.closed, false);
      assert.equal((await old.tools.canvas_agents.execute('stale', {})).details.code, 'QUERY_CONTEXT');
      assert.equal((await current.tools.canvas_agents.execute('fresh', { agentId: 'target' })).details.kind, 'agent');
      assert.equal((await current.tools.canvas_layout.execute('fresh', {})).isError, undefined);
    }
    const owner = Symbol('wrong');
    detachQueryProcess(broker, owner, 'quit'); assert.equal(broker.client.closed, false);
    assert.throws(() => bindQueryProcess({ config: { ...channel.config, generation: randomUUID() }, name: f.memory.name, epoch: f.memory.epoch, owner }), { code: 'SHM_VERSION' });
    current.handlers.session_shutdown({ reason: 'quit' });
    assert.equal(broker.client.closed, true);
  } finally {
    process[Symbol.for('agent-canvas.queries.process.v1')]?.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
    f.close();
  }
});

test('layout query samples lease expiry on demand rather than caching a busy flag', async () => {
  let clock = 100;
  const layout = new CanvasLayout(() => [{ kind: 'note', id: 'lease', x: 0, y: 0, width: 200, height: 200 }], { now: () => clock, leaseMs: 10 });
  const f = fixture({ execute: () => queryPage('objects', layout.snapshot().objects) });
  try {
    layout.interaction('note', 'lease', 'human-owner', 'start');
    assert.equal((await f.client.query('layout')).objects[0].busy, true);
    clock = 111;
    assert.equal((await f.client.query('layout')).objects[0].busy, false);
  } finally { f.close(); }
});

test('app SHM metadata/layout reads are precise; removed HTTP GETs are 404 while state/PATCH/output remain', async () => {
  const children = [];
  const app = createApp({ port: 0, spawnAgent(_bin, args, options) {
    const child = new EventEmitter();
    Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } });
  await app.listen();
  const request = async (path, method = 'GET', body, human = false) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(human ? { 'X-Canvas-Layout': 'human' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const agent = (await request('/agents', 'POST', { name: 'Precise query', workdir: process.cwd(), task: 'Complete private task 🧋' })).body;
    const peer = (await request('/agents', 'POST', { name: 'Peer', workdir: process.cwd() })).body;
    const box = (await request('/card-box/agent', 'POST', {})).body;
    const client = queryFixture(children[0]);
    const env = children[0].options.env;
    assert.ok(children[0].args.some(arg => arg.endsWith('/pi-canvas-queries.js')));
    assert.equal(JSON.parse(env.AGENT_CANVAS_SHM_QUERIES).generation, app.runtime.get(agent.id).processGeneration);
    children[0].emit('data', 'PRIVATE TERMINAL');
    const one = await client.query('agent', { agentId: agent.id });
    assert.equal(one.agent.task, 'Complete private task 🧋');
    assert.equal(one.agent.output, undefined);
    assert.deepEqual(one.agent, app.runtime.get(agent.id));
    const page = await client.query('agents', { offset: 1, limit: 1 });
    assert.equal(page.total, 3); assert.equal(page.nextOffset, 2); assert.equal(page.agents[0].id, peer.id);
    for (const path of ['/agents', `/agents/${agent.id}`, '/agents/missing', '/canvas/layout']) assert.equal((await request(path)).status, 404);
    assert.equal((await request('/state')).status, 200);
    assert.equal((await request(`/agents/${agent.id}/output`)).body.output, 'PRIVATE TERMINAL');
    assert.equal((await request(`/agents/${agent.id}`, 'PATCH', { name: 'Renamed', x: -2000 })).status, 200);
    assert.equal((await client.query('agent', { agentId: agent.id })).agent.name, 'Renamed');
    const note = (await request('/notes', 'POST', { text: 'Lease query', x: 4000, y: 4000 })).body;
    const layout = () => client.query('layout', { limit: 100 });
    assert.equal((await layout()).objects.some(o => o.id === box.id), false);
    const lease = `/canvas/layout-interactions/note/${note.id}`;
    await request(lease, 'POST', { owner: 'tab-a', action: 'start' }, true);
    assert.equal((await layout()).objects.find(o => o.id === note.id).busy, true);
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { x: 4500 })).status, 409);
    await request(lease, 'POST', { owner: 'tab-a', action: 'end' }, true);
    assert.equal((await layout()).objects.find(o => o.id === note.id).busy, false);
    // A read never reserves the object: a newer human gesture must still win.
    await request(lease, 'POST', { owner: 'tab-b', action: 'start' }, true);
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { x: 4500 })).body.code, 'LAYOUT_BUSY');
    await assert.rejects(client.query('agent', { agentId: 'missing' }), { code: 'QUERY_NOT_FOUND' });
    await request(`/agents/${peer.id}/stop`, 'POST', {});
    assert.equal((await client.query('agent', { agentId: peer.id })).agent.status, 'stopped');
  } finally { await app.close(); }
});
