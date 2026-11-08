import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

function fixture(apply, options = {}) {
  const state = { agents: ['a', 'b'].map(id => ({ id, name: id, status: 'running', activity: 'idle', processGeneration: randomUUID() })), edges: [], notes: [], cards: [], cardPlacements: [] };
  const memory = createCanvasMemory({ getState: () => state });
  const frames = [], errors = [];
  const service = createCanvasTelemetry({ epoch: memory.epoch, apply: apply ?? ((id, generation, frame) => frames.push({ id, generation, ...frame })), watchdogMs: 60000, onError: error => errors.push(error), ...options });
  const channel = service.createChannel('a', state.agents[0].processGeneration);
  let client;
  return { state, memory, service, channel, frames, errors,
    client(options = {}) { return client ??= createCanvasTelemetryClient({ config: channel.config, name: memory.name, epoch: memory.epoch, watchdogMs: 60000, ...options }); },
    pump() { service.drain(); client?.drain(); },
    close() { client?.close(); service.close(); memory.close(); },
  };
}
const errorCode = code => error => error.code === code;
// Only our fresh, private fixture name; never touch a live publisher.
const staleHeartbeat = memory => execFileSync('python3', [new URL('../scripts/tests/shm-corrupt.py', import.meta.url).pathname, 'field', memory.name, '6', '0']);
function trackerInstance() {
  const hooks = new Map(), tools = new Map(), warnings = [];
  tracker({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool) });
  return { hooks, tools, context: id => ({ mode: 'tui', hasUI: true, isIdle: () => true, ui: { notify: (...args) => warnings.push(args) }, sessionManager: { getSessionFile: () => `/owned/${id}.jsonl`, getSessionId: () => id } }), warnings };
}

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
    assert.equal(applied, true); assert.equal(client.closed, false); assert.equal(client.fenced, true);
    assert.equal(client.status(sent.seq).status, 'unknown');
    assert.throws(() => client.send('progress', { text: 'No retry' }), errorCode('TELEMETRY_CHANNEL_FENCED'));
  } finally { f.close(); }
});

nativeTest('SHM telemetry remains process-owned across new/reload/resume/fork; stale handlers/tools cannot publish', async () => {
  const f = fixture(), saved = { ...process.env }, originalFetch = globalThis.fetch;
  const key = Symbol.for('agent-canvas.telemetry.process.v1');
  const instance = trackerInstance;
  try {
    Object.assign(process.env, { AGENT_CANVAS_ID: 'a', AGENT_CANVAS_URL: '',
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
    assert.equal(client.closed, false); assert.equal(client.fenced, true); assert.equal(client.status(sent.seq).status, 'unknown');
    assert.throws(() => client.send('progress', { text: 'No reconnect' }), errorCode('TELEMETRY_CHANNEL_FENCED'));
  } finally { f.close(); }
});

nativeTest('stale heartbeat pauses without releasing queues or replaying reports; same-epoch recovery retains evidence', () => {
  const f = fixture(), errors = [], ready = [];
  try {
    const client = f.client({ onError: error => errors.push(error.code), onReady: state => ready.push(state) });
    const sent = client.send('progress', { text: 'Applied before sleep' });
    f.service.drain(); // Receipt exists but has not yet been read.
    staleHeartbeat(f.memory); client.drain();
    assert.equal(client.paused, true); assert.equal(client.closed, false);
    assert.equal(client.available, 0); assert.equal(client.status(sent.seq).status, 'unknown');
    for (let i = 0; i < 3; i++) client.drain();
    assert.throws(() => client.send('progress', { text: 'Do not defer me' }), errorCode('SHM_STALE'));
    assert.deepEqual(errors, ['SHM_STALE']);
    f.memory.publish(); client.drain();
    assert.equal(client.paused, false); assert.equal(client.status(sent.seq).status, 'applied');
    assert.equal(ready.filter(state => state.resumed).length, 1);
    assert.equal(client.send('progress', { text: 'New report only' }).seq, 2);
    f.pump();
    assert.deepEqual(f.frames.map(frame => frame.data.text), ['Applied before sleep', 'New report only']);
  } finally { f.close(); }
});

nativeTest('wake refresh samples the current binding, waits for credits, and never queues progress during sleep', async () => {
  let clock;
  const f = fixture(undefined, { now: () => clock ?? Date.now() }), saved = { ...process.env }, originalFetch = globalThis.fetch;
  const key = Symbol.for('agent-canvas.telemetry.process.v1');
  try {
    Object.assign(process.env, { AGENT_CANVAS_ID: 'a', AGENT_CANVAS_URL: '',
      AGENT_CANVAS_SHM_TELEMETRY: JSON.stringify(f.channel.config), AGENT_CANVAS_SHM_NAME: f.memory.name, AGENT_CANVAS_SHM_EPOCH: f.memory.epoch });
    globalThis.fetch = () => { throw new Error('HTTP forbidden'); };
    const old = trackerInstance();
    await old.hooks.get('session_start')({}, old.context('before-sleep'));
    const broker = process[key], client = broker.client;
    f.service.drain(); client.drain(); f.frames.length = 0;
    for (let i = 0; i < 16; i++) broker.publish('progress', { text: `Do not replay ${i}` });
    staleHeartbeat(f.memory); client.drain();
    assert.match(old.warnings.at(-1)[0], /paused.*SHM_STALE/);
    old.hooks.get('session_shutdown')({ reason: 'reload' });
    const current = trackerInstance(), ctx = current.context('current-session');
    let idle = true, session = 'during-sleep';
    ctx.isIdle = () => idle;
    ctx.sessionManager = { getSessionFile: () => `/owned/${session}.jsonl`, getSessionId: () => session };
    await current.hooks.get('session_start')({}, ctx);
    await assert.rejects(current.tools.get('canvas_set_progress').execute('paused', { text: 'Never deferred' }), errorCode('SHM_STALE'));
    await assert.rejects(old.tools.get('canvas_set_progress').execute('stale', { text: 'Old context' }), errorCode('TELEMETRY_CONTEXT'));
    assert.equal(client.closed, false); assert.equal(process[key], broker);
    f.memory.publish(); client.drain();
    assert.equal(client.paused, false); assert.equal(broker.refreshPending, true);
    assert.equal(f.frames.length, 0, 'full window defers fresh snapshots, not old reports');
    // The server rejects reports that expired during sleep, without applying them.
    clock = Date.now() + 11000; f.service.drain(); clock = undefined;
    idle = false; session = 'latest-at-recovery';
    client.drain(); f.service.drain(); client.drain();
    assert.equal(broker.refreshPending, false);
    assert.deepEqual(f.frames.map(frame => [frame.kind, frame.seq, frame.data]), [
      ['session', 19, { sessionFile: '/owned/latest-at-recovery.jsonl', sessionId: 'latest-at-recovery' }],
      ['activity', 20, { state: 'working' }],
    ]);
    assert.equal(current.warnings.filter(([message]) => message.includes('heartbeat recovered')).length, 1);
    client.drain(); f.service.drain(); assert.equal(f.frames.length, 2, 'no repeated recovery reports');
    const progress = await current.tools.get('canvas_set_progress').execute('new', { text: 'New progress after wake' });
    f.service.drain(); client.drain();
    assert.equal(client.status(progress.details.seq).status, 'applied');
    assert.equal(f.frames.at(-1).data.text, 'New progress after wake');
    // Recovery while detached must not sample the previous context or wake a model.
    staleHeartbeat(f.memory); client.drain();
    current.hooks.get('session_shutdown')({ reason: 'new' });
    const before = f.frames.length;
    f.memory.publish(); client.drain(); f.service.drain();
    assert.equal(f.frames.length, before);
    const replacement = trackerInstance();
    await replacement.hooks.get('session_start')({}, replacement.context('after-detached-wake'));
    f.service.drain(); client.drain();
    assert.equal(f.frames.at(-1).data.sessionId, 'after-detached-wake');
    assert.equal(broker.refreshPending, false);
  } finally { process[key]?.close(); globalThis.fetch = originalFetch; process.env = saved; f.close(); }
});

nativeTest('transient snapshot failures pause telemetry without closing process resources', () => {
  for (const code of ['SHM_BUSY', 'SHM_NOT_READY', 'SHM_UNAVAILABLE']) {
    const f = fixture(); let failure = code;
    try {
      const client = f.client({ open: (...args) => {
        const reader = openCanvasMemory(...args);
        return { read() { if (failure) throw Object.assign(new Error('Temporary snapshot failure'), { code: failure }); return reader.read(); }, close: () => reader.close() };
      } });
      assert.equal(client.closed, false); assert.equal(client.paused, true);
      assert.throws(() => client.send('progress', { text: 'Not deferred' }), errorCode(code));
      failure = null; client.drain();
      assert.equal(client.paused, false);
      const sent = client.send('progress', { text: 'Fresh after recovery' }); f.pump();
      assert.equal(client.status(sent.seq).status, 'applied'); assert.equal(f.frames.length, 1);
      client.close(); assert.equal(client.closed, true);
    } finally { f.close(); }
  }
});

nativeTest('initial stale heartbeat can recover, but closed/replaced/incompatible generations remain fenced', () => {
  for (const failure of ['closed', 'epoch', 'corrupt']) {
    const f = fixture();
    let incompatible = false;
    try {
      staleHeartbeat(f.memory);
      const client = f.client({ open: (name, epoch) => openCanvasMemory(name, incompatible ? 'replacement-epoch' : epoch) });
      assert.equal(client.paused, true); assert.equal(client.closed, false);
      f.memory.publish(); client.drain();
      assert.equal(client.paused, false);
      const sent = client.send('progress', { text: 'Uncertain' });
      staleHeartbeat(f.memory); client.drain();
      if (failure === 'closed') f.memory.close();
      else if (failure === 'epoch') { incompatible = true; f.memory.publish(); }
      else {
        f.memory.publish();
        execFileSync('python3', [new URL('../scripts/tests/shm-corrupt.py', import.meta.url).pathname, 'field', f.memory.name, '5', '0']);
      }
      client.drain();
      assert.equal(client.closed, false, failure); assert.equal(client.fenced, true, failure);
      assert.throws(() => messagingNative().queueOpen(f.channel.config.reports, 'producer'), errorCode('SHM_BUSY'), 'process still owns its original queue claim');
      f.memory.publish(); client.drain(); assert.equal(client.fenced, true, 'fatal fencing never reconnects');
      assert.equal(client.status(sent.seq).status, 'unknown');
      assert.throws(() => client.send('progress', { text: 'No reconnect' }), errorCode('TELEMETRY_CHANNEL_FENCED'));
    } finally { f.close(); }
  }
});

const eventually = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for native telemetry');
};
nativeTest('production runtime receives session/activity/progress, persists metadata only, fences older sequences and rejects retired HTTP reporting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-telemetry-runtime-')), children = [];
  const file = join(directory, 'canvas.json');
  const app = createApp({ port: 0, stateFile: file, spawnAgent: (_bin, args, options) => {
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
    assert.equal(env.AGENT_CANVAS_TELEMETRY_TRANSPORT, undefined);
    assert.throws(() => app.runtime.applyTelemetry(agent.id, 'stale-generation', { kind: 'progress', data: { text: 'Spoofed' } }), errorCode('TELEMETRY_GENERATION'));
    assert.equal(app.snapshot().agents[0].note, '');
    assert.equal((await request(`/agents/${agent.id}/activity`, { state: 'idle', seq: 100 })).status, 404);
    assert.equal((await request(`/agents/${agent.id}/session`, { sessionFile: null, sessionId: 'mixed' })).status, 404);
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
    // Runtime fencing is process-wide across report kinds, not just per-kind.
    app.runtime.applyTelemetry(agent.id, config.generation, { seq: 2, kind: 'session', data: { sessionFile: null, sessionId: 'late-older' } });
    app.runtime.applyTelemetry(agent.id, config.generation, { seq: 3, kind: 'progress', data: { text: 'Late overwrite' } });
    assert.equal(app.snapshot().agents[0].sessionId, 'owned-session');
    assert.equal(app.snapshot().agents[0].note, 'Telemetry result 🧋');
    assert.throws(() => app.runtime.applyTelemetry(agent.id, config.generation, { seq: 0, kind: 'activity', data: { state: 'working' } }), /Invalid telemetry sequence/);
    // Progress metadata publication is coalesced; force no new server writes.
    await new Promise(resolve => setTimeout(resolve, 80));
    const reader = openCanvasMemory(env.AGENT_CANVAS_SHM_NAME, env.AGENT_CANVAS_SHM_EPOCH);
    try {
      const projected = reader.read(), raw = JSON.stringify(projected);
      assert.deepEqual(projected.events.filter(event => ['working', 'idle', 'progress'].includes(event.type)).map(event => event.type), ['working', 'idle', 'progress']);
      for (const secret of ['OWNED_SECRET_SESSION', 'owned-session', config.reports, config.receipts]) assert.equal(raw.includes(secret), false);
    } finally { reader.close(); }
    await app.close();
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.agents[0].sessionId, 'owned-session');
    assert.equal(persisted.agents[0].note, 'Telemetry result 🧋');
    assert.equal(persisted.agents[0].activity, undefined);
    assert.ok(!JSON.stringify(persisted).includes(config.reports));
    assert.equal(env.AGENT_CANVAS_RUN, undefined);
    client.drain(); assert.equal(client.closed, false); assert.equal(client.fenced, true);
  } finally { client?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
