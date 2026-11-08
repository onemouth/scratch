import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvasMemory } from './canvas-memory.js';
import { createCanvasTelemetry } from './canvas-telemetry.js';
import { createCanvasTelemetryClient } from './canvas-telemetry-client.js';
import { createCanvasMessaging } from './canvas-messages.js';
import { createCanvasMessageClient } from './canvas-message-client.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { TELEMETRY_VERSION, validateTelemetryData } from '../shared/canvas-telemetry.js';
import tracker from './pi-session-tracker.js';
import { createApp } from './index.js';
import { openCanvasMemory } from '../shared/canvas-memory.js';

const built = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: built ? false : 'Run npm run test:shm to build the native addon' }, fn);

function fixture(apply) {
  const state = { agents: ['a', 'b'].map(id => ({ id, name: id, status: 'running', activity: 'idle', processGeneration: randomUUID() })), edges: [], notes: [], cards: [], cardPlacements: [] };
  const memory = createCanvasMemory({ getState: () => state });
  const frames = [], errors = [];
  const service = createCanvasTelemetry({ epoch: memory.epoch, apply: apply ?? ((id, generation, frame) => frames.push({ id, generation, ...frame })), watchdogMs: 60000, onError: error => errors.push(error) });
  const channel = service.createChannel('a', state.agents[0].processGeneration);
  let client;
  return { state, memory, service, channel, frames, errors,
    client(options = {}) { return client ??= createCanvasTelemetryClient({ config: channel.config, name: memory.name, epoch: memory.epoch, watchdogMs: 60000, ...options }); },
    pump() { service.drain(); client?.drain(); },
    close() { client?.close(); service.close(); memory.close(); },
  };
}
const errorCode = code => error => error.code === code;

nativeTest('telemetry uses real independent queues, inferred identity, bounded reports and applied receipts', () => {
  const f = fixture();
  try {
    const client = f.client();
    const values = [client.send('activity', { state: 'working' }), client.send('session', { sessionFile: '/owned/私有.jsonl', sessionId: 'one' }), client.send('progress', { text: '進度 🧋' }), client.send('activity', { state: 'idle', summary: 'Finished' })];
    assert.deepEqual(values.map(value => value.seq), [1, 2, 3, 4]);
    assert.ok(values.every(value => value.status === 'queued'));
    f.pump();
    assert.deepEqual(f.frames.map(frame => frame.kind), ['activity', 'session', 'progress', 'activity']);
    assert.ok(f.frames.every(frame => frame.id === 'a' && frame.generation === f.channel.config.generation));
    assert.ok(values.every(value => client.status(value.seq).status === 'applied'));
    assert.throws(() => client.send('progress', { text: 'x', agentId: 'b' }), errorCode('TELEMETRY_ARGUMENT'));
    assert.throws(() => client.send('progress', { text: 'x'.repeat(501) }), errorCode('TELEMETRY_ARGUMENT'));
    assert.throws(() => validateTelemetryData('session', { sessionId: 'x', sessionFile: 'relative' }), errorCode('TELEMETRY_ARGUMENT'));
    assert.throws(() => client.send('activity', { state: 'working', summary: 'No' }), errorCode('TELEMETRY_ARGUMENT'));
    assert.equal(client.send('progress', { text: '' }).seq, 5);
    f.pump();
    assert.equal(f.frames.at(-1).data.text, '');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

nativeTest('telemetry malformed/expired/duplicate frames are rejected without reapplication or peer identity injection', () => {
  const f = fixture(), native = messagingNative();
  const raw = messageQueue(native, native.queueOpen(f.channel.config.reports, 'producer'));
  const receipts = messageQueue(native, native.queueOpen(f.channel.config.receipts, 'consumer'));
  const frame = seq => ({ version: TELEMETRY_VERSION, seq, kind: 'progress', data: { text: 'Once' }, expiresAt: Date.now() + 9000 });
  try {
    raw.push(frame(1)); raw.push(frame(1)); raw.push({ ...frame(2), agentId: 'b' }); raw.push({ ...frame(3), expiresAt: Date.now() - 1 }); raw.push({ bad: true });
    f.service.drain();
    const statuses = [];
    for (let entry; (entry = receipts.peek());) { statuses.push(entry.value); receipts.shift(entry.sequence); }
    assert.deepEqual(statuses.map(value => value.status), ['applied', 'rejected', 'rejected', 'rejected']);
    assert.deepEqual(statuses.slice(1).map(value => value.code), ['TELEMETRY_SEQUENCE', 'TELEMETRY_ARGUMENT', 'TELEMETRY_EXPIRED']);
    assert.equal(f.frames.length, 1);
    assert.equal(f.errors.length, 1);
  } finally { raw.close(); receipts.close(); f.close(); }
});

nativeTest('full telemetry receipt window does not block peer messages; lost hints recover by draining', () => {
  const f = fixture();
  let router, a, b;
  try {
    const client = f.client();
    for (let i = 0; i < 16; i++) client.send('progress', { text: String(i) });
    assert.throws(() => client.send('activity', { state: 'working' }), errorCode('TELEMETRY_LIMIT'));
    router = createCanvasMessaging({ epoch: f.memory.epoch, getAgent: id => f.state.agents.find(agent => agent.id === id) });
    const received = [];
    const configA = router.createChannel('a', f.state.agents[0].processGeneration).config;
    const configB = router.createChannel('b', f.state.agents[1].processGeneration).config;
    a = createCanvasMessageClient({ config: configA, name: f.memory.name, epoch: f.memory.epoch, deliver() {} });
    b = createCanvasMessageClient({ config: configB, name: f.memory.name, epoch: f.memory.epoch, deliver: frame => received.push(frame) });
    const sent = a.send({ agentId: 'b', text: 'Independent peer transport' });
    router.drain(); b.drain(); router.drain(); a.drain();
    assert.equal(received[0].text, 'Independent peer transport');
    assert.equal(a.status(sent.messageId).status, 'delivered');
    f.pump();
    assert.equal(client.send('activity', { state: 'working' }).seq, 17);
    f.pump(); assert.equal(client.status(17).status, 'applied');
  } finally { a?.close(); b?.close(); router?.close(); f.close(); }
});

nativeTest('post-application failure fences telemetry as unknown, never safe-to-retry rejected', () => {
  let applied = false;
  const f = fixture(() => { applied = true; throw new Error('after commit'); });
  try {
    const client = f.client(), sent = client.send('progress', { text: 'Committed' });
    f.pump();
    assert.equal(applied, true); assert.equal(client.closed, true);
    assert.equal(client.status(sent.seq).status, 'unknown');
    assert.throws(() => client.send('progress', { text: 'No retry' }), errorCode('SHM_CLOSED'));
  } finally { f.close(); }
});

nativeTest('SHM telemetry remains process-owned across new/reload/resume/fork; stale handlers/tools cannot publish', async () => {
  const f = fixture(), saved = { ...process.env }, originalFetch = globalThis.fetch;
  const key = Symbol.for('agent-canvas.telemetry.process.v1');
  const instance = () => {
    const hooks = new Map(), tools = new Map(), warnings = [];
    tracker({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool) });
    return { hooks, tools, context: id => ({ mode: 'tui', hasUI: true, isIdle: () => true, ui: { notify: (...args) => warnings.push(args) }, sessionManager: { getSessionFile: () => `/owned/${id}.jsonl`, getSessionId: () => id } }), warnings };
  };
  try {
    Object.assign(process.env, { AGENT_CANVAS_ID: 'a', AGENT_CANVAS_URL: '', AGENT_CANVAS_RUN: '', AGENT_CANVAS_TELEMETRY_TRANSPORT: 'shm',
      AGENT_CANVAS_SHM_TELEMETRY: JSON.stringify(f.channel.config), AGENT_CANVAS_SHM_NAME: f.memory.name, AGENT_CANVAS_SHM_EPOCH: f.memory.epoch });
    globalThis.fetch = () => { throw new Error('HTTP forbidden'); };
    let current = instance();
    assert.equal(process[key], undefined, 'factory must not allocate resources');
    await current.hooks.get('session_start')({}, current.context('startup'));
    const broker = process[key], client = broker.client;
    f.service.drain(); client.drain();
    const first = await current.tools.get('canvas_set_progress').execute('progress', { text: 'Original' });
    f.service.drain(); client.drain();
    current.hooks.get('agent_start')();
    current.hooks.get('message_end')({ message: { role: 'assistant', content: [{ type: 'text', text: '**Completed** via SHM 🧋' }] } });
    current.hooks.get('agent_settled')({}, { isIdle: () => true });
    f.service.drain(); client.drain();
    assert.deepEqual(f.frames.slice(-2).map(frame => frame.data), [{ state: 'working' }, { state: 'idle', summary: 'Completed via SHM 🧋' }]);
    for (const reason of ['reload', 'new', 'resume', 'fork']) {
      const old = current, lastSeq = f.frames.at(-1).seq;
      old.hooks.get('session_shutdown')({ reason });
      assert.equal(client.closed, false);
      current = instance();
      await current.hooks.get('session_start')({}, current.context(reason));
      old.hooks.get('session_shutdown')({ reason: 'quit' });
      old.hooks.get('agent_start')();
      await assert.rejects(old.tools.get('canvas_set_progress').execute('stale', { text: 'No' }), errorCode('TELEMETRY_CONTEXT'));
      f.service.drain(); client.drain();
      assert.equal(process[key], broker); assert.equal(client.closed, false);
      assert.ok(f.frames.at(-1).seq > lastSeq);
      assert.equal(f.frames.at(-1).data.sessionId, reason);
      assert.equal(client.status(first.details.seq).status, 'applied');
      assert.deepEqual(current.warnings, []);
    }
    current.hooks.get('session_shutdown')({ reason: 'quit' });
    assert.equal(client.closed, true); assert.equal(process[key], undefined);
  } finally { process[key]?.close(); globalThis.fetch = originalFetch; process.env = saved; f.close(); }
});

nativeTest('telemetry timeouts stay unknown without resend; late receipts and bounded history retain actual evidence', () => {
  const f = fixture(), noHints = Object.create(messagingNative());
  Object.defineProperty(noHints, 'signalPost', { value: () => { throw Object.assign(new Error('Lost hint'), { code: 'SHM_SIGNAL' }); } });
  let clock = Date.now();
  try {
    const client = f.client({ native: noHints, now: () => clock });
    const sent = client.send('progress', { text: 'Once only' });
    assert.equal(sent.status, 'queued'); assert.equal(sent.notificationWarning, 'SHM_SIGNAL');
    clock += 10001; client.drain();
    assert.equal(client.status(sent.seq).status, 'unknown'); assert.equal(f.frames.length, 0);
    f.pump(); // Actual server application can establish evidence after a local timeout.
    assert.equal(client.status(sent.seq).status, 'applied'); assert.equal(f.frames.length, 1);
    clock = Date.now();
    for (let i = 0; i < 70; i++) { client.send('progress', { text: String(i) }); f.pump(); }
    assert.equal(client.status(sent.seq).code, 'TELEMETRY_HISTORY_MISSING');
    assert.equal(f.frames.length, 71);
  } finally { f.close(); }
});

nativeTest('wrong server epoch fails before claiming queues; a closed server fences pending telemetry', () => {
  const f = fixture();
  try {
    assert.throws(() => createCanvasTelemetryClient({ config: { ...f.channel.config, epoch: 'different' }, name: f.memory.name, epoch: 'different' }), errorCode('SHM_VERSION'));
    const client = f.client(), sent = client.send('progress', { text: 'Pending' });
    f.memory.close(); client.drain();
    assert.equal(client.closed, true); assert.equal(client.status(sent.seq).status, 'unknown');
    assert.throws(() => client.send('progress', { text: 'No reconnect' }), errorCode('SHM_CLOSED'));
  } finally { f.close(); }
});

const eventually = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for native telemetry');
};
nativeTest('production runtime receives session/activity/progress, persists metadata only and rejects mixed HTTP reporting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-telemetry-runtime-')), children = [];
  const file = join(directory, 'canvas.json');
  const app = createApp({ port: 0, sharedMemory: true, stateFile: file, spawnAgent: (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } });
  let client;
  try {
    await app.listen();
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const request = async (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const agent = await (await request('/agents', { name: 'Telemetry runtime', workdir: directory })).json();
    const env = children[0].options.env, config = JSON.parse(env.AGENT_CANVAS_SHM_TELEMETRY);
    assert.equal(env.AGENT_CANVAS_TELEMETRY_TRANSPORT, 'shm');
    assert.throws(() => app.runtime.applyTelemetry(agent.id, 'stale-generation', { kind: 'progress', data: { text: 'Spoofed' } }), errorCode('TELEMETRY_GENERATION'));
    assert.equal(app.snapshot().agents[0].note, '');
    assert.equal((await request(`/agents/${agent.id}/activity`, { runToken: env.AGENT_CANVAS_RUN, state: 'idle', seq: 100 })).status, 409);
    assert.equal((await request(`/agents/${agent.id}/session`, { runToken: env.AGENT_CANVAS_RUN, sessionFile: null, sessionId: 'mixed' })).status, 409);
    client = createCanvasTelemetryClient({ config, name: env.AGENT_CANVAS_SHM_NAME, epoch: env.AGENT_CANVAS_SHM_EPOCH });
    client.send('session', { sessionFile: '/private/OWNED_SECRET_SESSION.jsonl', sessionId: 'owned-session' });
    client.send('activity', { state: 'working' });
    client.send('activity', { state: 'idle', summary: 'Completed via SHM' });
    const progress = client.send('progress', { text: 'Telemetry result 🧋' });
    await eventually(() => { client.drain(); return client.status(progress.seq).status === 'applied'; });
    const state = app.snapshot();
    assert.equal(state.agents[0].activity, 'idle');
    assert.equal(state.agents[0].notificationSummary, 'Completed via SHM');
    assert.equal(state.agents[0].sessionId, 'owned-session');
    assert.equal(state.agents[0].note, 'Telemetry result 🧋');
    // Progress metadata publication is coalesced; force no new server writes.
    await new Promise(resolve => setTimeout(resolve, 80));
    const reader = openCanvasMemory(env.AGENT_CANVAS_SHM_NAME, env.AGENT_CANVAS_SHM_EPOCH);
    try {
      const projected = reader.read(), raw = JSON.stringify(projected);
      assert.deepEqual(projected.events.filter(event => ['working', 'idle', 'progress'].includes(event.type)).map(event => event.type), ['working', 'idle', 'progress']);
      for (const secret of ['OWNED_SECRET_SESSION', 'owned-session', config.reports, config.receipts, env.AGENT_CANVAS_RUN]) assert.equal(raw.includes(secret), false);
    } finally { reader.close(); }
    await app.close();
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.agents[0].sessionId, 'owned-session');
    assert.equal(persisted.agents[0].note, 'Telemetry result 🧋');
    assert.equal(persisted.agents[0].activity, undefined);
    assert.ok(!JSON.stringify(persisted).includes(config.reports));
    assert.ok(!JSON.stringify(persisted).includes(env.AGENT_CANVAS_RUN));
    client.drain(); assert.equal(client.closed, true);
  } finally { client?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
