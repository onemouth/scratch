import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createCanvasMemory } from './canvas-memory.js';
import { createCanvasSubscriptions } from './canvas-notify.js';
import { nativeMemory, memoryName } from '../shared/canvas-memory.js';
import memoryExtension from './pi-canvas-memory.js';
import { createApp } from './index.js';
import { EventEmitter } from 'node:events';
import { openCanvasMemory } from '../shared/canvas-memory.js';

const built = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: built ? false : 'Run npm run build:shm' }, fn);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); } assert.fail('Notification deadline'); }
function fixture() {
  let state = { notificationVersion: 1, eventSequence: 0, events: [], agents: [{ id: 'a' }] }, callback;
  const delivered = [], errors = []; let closed = 0, race;
  const native = { signalWatch(_name, fn) { callback = fn; race?.(); return {}; }, signalClose() { closed++; } };
  const controller = createCanvasSubscriptions({ name: 'fixture', epoch: 'epoch', signalName: 'fixture', native,
    open: () => ({ read: () => state, close() {} }), deliver: (event, sub) => delivered.push({ event, sub }), onError: error => errors.push(error) });
  return { controller, delivered, errors, setRace(fn) { race = fn; }, get closed() { return closed; },
    append(type, overrides = {}) { const event = { sequence: ++state.eventSequence, type, agentId: 'a', generation: 'g', ...overrides }; state.events.push(event); },
    signal() { callback(); }, reset(next) { state = next; } };
}

test('subscriptions return immediately, preserve fast transitions, support once and local cancellation', () => {
  const f = fixture();
  try {
    const first = f.controller.subscribe({ agentId: 'a', events: ['idle', 'working'] });
    const second = f.controller.subscribe({ agentId: 'a', events: ['idle'], once: true });
    assert.equal(f.delivered.length, 0);
    f.append('idle'); f.append('working'); f.signal();
    assert.deepEqual(f.delivered.filter(x => x.event.subscriptionId === first.subscriptionId).map(x => x.event.type), ['idle', 'working']);
    assert.equal(f.delivered.filter(x => x.event.subscriptionId === second.subscriptionId).length, 1);
    f.signal(); assert.equal(f.delivered.length, 3);
    assert.equal(f.controller.unsubscribe(first.subscriptionId).removed, 1);
    assert.equal(f.controller.size, 0); assert.equal(f.closed, 1);
  } finally { f.controller.close(); }
});

test('registration recheck prevents lost wakeups; generation filtering and ring gaps are explicit', () => {
  const f = fixture();
  try {
    f.setRace(() => f.append('idle'));
    f.controller.subscribe({ agentId: 'a', events: ['idle'], generation: 'g' });
    assert.equal(f.delivered.length, 1);
    f.append('idle', { generation: 'other' }); f.signal(); assert.equal(f.delivered.length, 1);
    f.reset({ notificationVersion: 1, eventSequence: 999, events: [{ sequence: 999, type: 'idle', agentId: 'a' }], agents: [{ id: 'a' }] });
    f.signal(); assert.equal(f.errors[0].code, 'SHM_EVENTS_LOST'); assert.equal(f.controller.size, 0);
  } finally { f.controller.close(); }
});

test('excessive notification bursts stop explicitly instead of silently dropping delivery', () => {
  const f = fixture();
  try {
    f.controller.subscribe({ agentId: 'a', events: ['idle'] });
    for (let i = 0; i < 70; i++) f.append('idle');
    f.signal();
    assert.equal(f.delivered.length, 64);
    assert.equal(f.errors[0].code, 'SHM_NOTIFICATION_LIMIT');
    assert.equal(f.controller.size, 0);
  } finally { f.controller.close(); }
});

test('notification subscription parameters are bounded and wake requires explicit followUp delivery', () => {
  const f = fixture();
  try {
    for (const args of [{ agentId: 'missing' }, { agentId: 'a', wake: true }, { agentId: 'a', events: [] }, { agentId: 'a', delivery: 'bad' }]) {
      assert.throws(() => f.controller.subscribe(args));
    }
    for (let i = 0; i < 32; i++) f.controller.subscribe({ agentId: 'a' });
    assert.throws(() => f.controller.subscribe({ agentId: 'a' }), /32/);
    assert.equal(f.controller.unsubscribe('*').removed, 32);
  } finally { f.controller.close(); }
});

nativeTest('semaphore notifications reach two independent processes and preserve coalesced idle→working events', async () => {
  let agents = [{ id: 'target', name: 'Target', status: 'running', activity: 'working', processGeneration: 'generation-one', note: '' }];
  const publisher = createCanvasMemory({ getState: () => ({ agents, notes: [], cards: [], edges: [], cardPlacements: [] }) });
  const children = [], messages = [[], []];
  try {
    for (let i = 0; i < 2; i++) {
      const signal = publisher.createNotifier();
      const child = fork(new URL('../scripts/tests/shm-notify-child.mjs', import.meta.url), [publisher.name, publisher.epoch, signal.name, 'target'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child); child.on('message', value => messages[i].push(value));
    }
    await until(() => messages.every(list => list.some(message => message.ready)));
    agents[0] = { ...agents[0], activity: 'idle' }; publisher.observeAgents();
    agents[0] = { ...agents[0], activity: 'working' }; publisher.observeAgents();
    await until(() => messages.every(list => list.filter(message => message.event).length === 2));
    for (const list of messages) assert.deepEqual(list.filter(message => message.event).map(message => message.event.type), ['idle', 'working']);
    agents = []; publisher.observeAgents();
    await until(() => messages.every(list => list.some(message => message.event?.type === 'removed')));
    publisher.close();
    await until(() => messages.every(list => list.some(message => message.error)));
    for (const child of children) { const exit = once(child, 'exit'); child.send('close'); await exit; }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    publisher.close();
  }
});

nativeTest('HTTP runtime transitions publish immediately; Resume changes public generation and cleans old channel', async () => {
  const children = [];
  const app = createApp({ port: 0, sharedMemory: true, spawnAgent: (_bin, _args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn),
      write() {}, resize() {}, kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } });
  let reader;
  try {
    await app.listen();
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const post = async (path, body = {}) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok); return response.json();
    };
    const agent = await post('/agents', { name: 'Notification fixture', workdir: process.cwd() });
    reader = openCanvasMemory(app.sharedMemory.name, app.sharedMemory.epoch);
    const original = reader.read().agents[0].processGeneration;
    const channel = children[0].options.env.AGENT_CANVAS_SHM_NOTIFY;
    assert.ok(channel.startsWith('/scsh-'));
    assert.notEqual(original, children[0].options.env.AGENT_CANVAS_RUN);
    for (const [index, state] of ['working', 'idle', 'working'].entries()) {
      await post(`/agents/${agent.id}/activity`, { runToken: children[0].options.env.AGENT_CANVAS_RUN, state, seq: index + 1 });
    }
    assert.deepEqual(reader.read().events.slice(-3).map(event => event.type), ['working', 'idle', 'working']);
    await post(`/agents/${agent.id}/stop`);
    assert.equal(reader.read().events.at(-1).type, 'stopped');
    assert.throws(() => nativeMemory().signalWatch(channel, () => {}), { code: 'SHM_SIGNAL' });
    await post(`/agents/${agent.id}/resume`);
    const snapshot = reader.read();
    assert.equal(snapshot.events.at(-1).type, 'started');
    assert.notEqual(snapshot.agents[0].processGeneration, original);
    assert.notEqual(children[1].options.env.AGENT_CANVAS_SHM_NOTIFY, channel);
  } finally { reader?.close(); await app.close(); }
});

nativeTest('blocked semaphore listeners do not occupy the libuv pool; close and environment teardown are safe', async () => {
  const native = nativeMemory(), owners = [], receivers = [];
  try {
    for (let i = 0; i < 6; i++) {
      const name = memoryName(); owners.push(native.signalCreate(name)); receivers.push(native.signalWatch(name, () => {}));
    }
    await Promise.race([promisify(randomBytes)(16), delay(2000).then(() => { throw new Error('libuv pool blocked'); })]);
    assert.throws(() => native.signalPost(receivers[0]), { code: 'SHM_READ_ONLY' });
    const duplicateName = memoryName(), duplicateOwner = native.signalCreate(duplicateName);
    const first = native.signalWatch(duplicateName, () => {});
    try { assert.throws(() => native.signalWatch(duplicateName, () => {}), { code: 'SHM_SIGNAL' }); }
    finally { native.signalClose(first); native.signalClose(duplicateOwner); }
    native.signalClose(receivers.pop());
    const code = `import { nativeMemory,memoryName } from './shared/canvas-memory.js';
      const n=nativeMemory(),name=memoryName(); globalThis.owner=n.signalCreate(name); globalThis.receiver=n.signalWatch(name,()=>{});`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 });
  } finally { for (const r of receivers) native.signalClose(r); for (const o of owners) native.signalClose(o); }
});

nativeTest('Pi tools default to UI-only notification; conversation and wake delivery require explicit selection', async () => {
  const agents = [{ id: 'target', name: 'Target', status: 'running', activity: 'working', processGeneration: 'g' }];
  const publisher = createCanvasMemory({ getState: () => ({ agents, notes: [], cards: [], edges: [], cardPlacements: [] }) });
  const notifier = publisher.createNotifier();
  const keys = ['AGENT_CANVAS_SHM_NAME', 'AGENT_CANVAS_SHM_EPOCH', 'AGENT_CANVAS_SHM_NOTIFY'];
  const previous = keys.map(key => process.env[key]);
  const tools = new Map(), hooks = new Map(), notices = [], messages = [];
  try {
    [publisher.name, publisher.epoch, notifier.name].forEach((value, i) => { process.env[keys[i]] = value; });
    memoryExtension({ registerTool: tool => tools.set(tool.name, tool), on: (event, fn) => hooks.set(event, fn), sendMessage: (...args) => messages.push(args) });
    const ctx = { hasUI: true, ui: { notify: (...args) => notices.push(args) } };
    const subscribe = params => tools.get('canvas_subscribe').execute('test', { agentId: 'target', events: ['idle'], ...params }, undefined, undefined, ctx);
    await subscribe({});
    await subscribe({ delivery: 'nextTurn' });
    await subscribe({ delivery: 'followUp', wake: true, once: true });
    agents[0] = { ...agents[0], activity: 'idle' }; publisher.observeAgents();
    await until(() => notices.length === 1 && messages.length === 2);
    assert.deepEqual(messages.map(args => args[1]), [{ deliverAs: 'nextTurn', triggerTurn: false }, { deliverAs: 'followUp', triggerTurn: true }]);
    const result = await tools.get('canvas_unsubscribe').execute('test', { subscriptionId: '*' });
    assert.equal(result.details.removed, 2);
    hooks.get('session_shutdown')();
  } finally {
    hooks.get('session_shutdown')?.(); publisher.close();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});
