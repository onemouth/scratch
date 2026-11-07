import nodeTest from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createCanvasMemory } from './canvas-memory.js';
import { createCanvasMessaging } from './canvas-messages.js';
import { createCanvasMessageClient } from './canvas-message-client.js';
import messagesExtension from './pi-canvas-messages.js';
import { memoryName, nativeMemory, openCanvasMemory } from '../shared/canvas-memory.js';
import { messageQueue, QUEUE_SLOTS } from '../shared/canvas-messages.js';
import { createApp } from './index.js';

const built = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
const test = (name, fn) => nodeTest(name, { skip: built ? false : 'Run npm run build:shm' }, fn);
const native = built ? nativeMemory() : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } assert.fail('Timed out'); }
function fixture({ watchdogMs = 10000, nativeOverride = native } = {}) {
  let time = Date.now();
  const agents = new Map(['a', 'b', 'c'].map(id => [id, { id, name: id, status: 'running', activity: 'idle', processGeneration: randomUUID() }]));
  const state = { agents: [...agents.values()], edges: [], notes: [], cards: [], cardPlacements: [] };
  const memory = createCanvasMemory({ getState: () => state });
  const errors = [], received = new Map(), clients = new Map();
  const router = createCanvasMessaging({ epoch: memory.epoch, getAgent: id => agents.get(id), onError: error => errors.push(error), now: () => time, watchdogMs, native: nativeOverride });
  const channels = new Map([...agents].map(([id, agent]) => [id, router.createChannel(id, agent.processGeneration)]));
  function client(id, options = {}) {
    const values = []; received.set(id, values);
    const instance = createCanvasMessageClient({ config: channels.get(id).config, name: memory.name, epoch: memory.epoch,
      now: () => time, deliver: frame => values.push(frame), watchdogMs, native: nativeOverride, onError: error => errors.push(error), ...options });
    clients.set(id, instance); return instance;
  }
  return { agents, memory, router, channels, client, clients, received, errors, advance: ms => { time += ms; },
    pump() { router.drain(); for (const client of clients.values()) client.drain(); router.drain(); for (const client of clients.values()) client.drain(); },
    close() { for (const client of clients.values()) client.close(); router.close(); memory.close(); } };
}

test('SPSC queues enforce roles, framing, bounded capacity, ordered wraparound and generation closure', () => {
  const name = memoryName(), producer = native.queueCreate(name, 'producer', 1024);
  let consumer;
  try {
    consumer = native.queueOpen(name, 'consumer');
    assert.throws(() => native.queueOpen(name, 'consumer'), { code: 'SHM_BUSY' });
    assert.throws(() => native.queueOpen(name, 'producer'), { code: 'SHM_BUSY' });
    assert.throws(() => native.queuePush(consumer, Buffer.from('x')), { code: 'SHM_READ_ONLY' });
    assert.throws(() => native.queuePeek(producer), { code: 'SHM_READ_ONLY' });
    assert.throws(() => native.queuePush(producer, 'x'), { code: 'SHM_ARGUMENT' });
    assert.throws(() => native.queuePush(producer, Buffer.alloc(1025)), { code: 'SHM_CAPACITY' });
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < QUEUE_SLOTS; i++) native.queuePush(producer, Buffer.from(`訊息 ${round}/${i}`));
      assert.throws(() => native.queuePush(producer, Buffer.from('overflow')), { code: 'SHM_QUEUE_FULL' });
      assert.equal(native.queueState(producer).used, QUEUE_SLOTS);
      for (let i = 0; i < QUEUE_SLOTS; i++) {
        const entry = native.queuePeek(consumer);
        assert.equal(entry.payload.toString(), `訊息 ${round}/${i}`);
        assert.equal(native.queuePeek(consumer).sequence, entry.sequence);
        assert.throws(() => native.queueShift(consumer, entry.sequence + 1), { code: 'SHM_ARGUMENT' });
        native.queueShift(consumer, entry.sequence);
      }
      assert.equal(native.queuePeek(consumer), null);
    }
    native.queueClose(consumer); native.queueClose(consumer);
    assert.throws(() => native.queuePush(producer, Buffer.from('closed')), { code: 'SHM_CLOSED' });
    assert.throws(() => native.queueOpen(name, 'consumer'), { code: 'SHM_CLOSED' });
  } finally { if (consumer) native.queueClose(consumer); native.queueClose(producer); }
  assert.throws(() => native.queueOpen(name, 'consumer'), { code: 'SHM_MISSING' });
});

test('interrupted unpublished writes stay invisible and corrupt queue headers/lengths fail closed', () => {
  const corrupt = (name, field, value) => execFileSync('python3', [fileURLToPath(new URL('../scripts/tests/shm-queue-corrupt.py', import.meta.url)), name, String(field), String(value)]);
  for (const mode of ['unpublished', 'length', 'header', 'counter']) {
    const name = memoryName(), producer = native.queueCreate(name, 'producer', 1024), consumer = native.queueOpen(name, 'consumer');
    try {
      if (mode === 'unpublished') {
        corrupt(name, 16, 64); corrupt(name, 17, 123456);
        assert.equal(native.queuePeek(consumer), null);
        native.queuePush(producer, Buffer.from('committed'));
        assert.equal(native.queuePeek(consumer).payload.toString(), 'committed');
      } else if (mode === 'length') {
        native.queuePush(producer, Buffer.from('x')); corrupt(name, 16, 1025);
        assert.throws(() => native.queuePeek(consumer), { code: 'SHM_CORRUPT' });
      } else if (mode === 'header') {
        corrupt(name, 2, 8192);
        assert.throws(() => native.queuePush(producer, Buffer.from('x')), { code: 'SHM_CORRUPT' });
      } else {
        corrupt(name, 5, 17);
        assert.throws(() => native.queueState(consumer), { code: 'SHM_CORRUPT' });
      }
    } finally { native.queueClose(consumer); native.queueClose(producer); }
  }
});

test('actual child processes exchange 4000 ordered committed queue messages without HTTP', async () => {
  const out = memoryName(), back = memoryName();
  const producer = native.queueCreate(out, 'producer', 16384), consumer = native.queueCreate(back, 'consumer', 16384);
  let child;
  try {
    child = fork(fileURLToPath(new URL('../scripts/tests/shm-message-child.mjs', import.meta.url)), [out, back], { silent: true });
    const done = once(child, 'exit'); let sent = 0, got = 0, exited = false;
    child.once('exit', () => { exited = true; });
    for (let step = 0; step < 10000 && got < 4000; step++) {
      assert.equal(exited, false, 'Child exited early');
      while (sent < 4000 && native.queueState(producer).used < QUEUE_SLOTS) native.queuePush(producer, Buffer.from(JSON.stringify({ i: sent++, text: '跨程序 🧋'.repeat(20) })));
      let entry;
      while ((entry = native.queuePeek(consumer))) {
        const value = JSON.parse(entry.payload.toString());
        assert.equal(value.i, got++); assert.equal(value.text, '跨程序 🧋'.repeat(20)); native.queueShift(consumer, entry.sequence);
      }
      if (got < 4000) await delay(1);
    }
    assert.equal(got, 4000); child.send('done');
    assert.equal((await done)[0], 0);
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); native.queueClose(producer); native.queueClose(consumer); }
});

test('messages are queued then accepted then delivered, with pinned peer provenance and two-way Unicode delivery', () => {
  const f = fixture();
  try {
    const a = f.client('a'), b = f.client('b');
    const first = a.send({ agentId: 'b', text: '你好 🧋\nreview this' });
    assert.equal(first.status, 'queued'); assert.equal(a.status(first.messageId).status, 'queued');
    f.router.drain(); a.drain(); assert.equal(a.status(first.messageId).status, 'accepted');
    b.drain(); f.router.drain(); a.drain(); assert.equal(a.status(first.messageId).status, 'delivered');
    const frame = f.received.get('b')[0];
    assert.equal(frame.sourceId, 'a'); assert.equal(frame.sourceGeneration, f.agents.get('a').processGeneration);
    assert.equal(frame.generation, f.agents.get('b').processGeneration); assert.equal(frame.delivery, 'nextTurn'); assert.equal(frame.wake, false);
    const reply = b.send({ agentId: 'a', text: 'Done', delivery: 'followUp', wake: true }); f.pump();
    assert.equal(b.status(reply.messageId).status, 'delivered'); assert.equal(f.received.get('a')[0].wake, true);
    assert.equal(f.errors.length, 0);
  } finally { f.close(); }
});

test('semaphores alone route and confirm delivery promptly without watchdog or HTTP', async () => {
  const f = fixture();
  try {
    const a = f.client('a'); f.client('b');
    const result = a.send({ agentId: 'b', text: 'Signal only' });
    await until(() => a.status(result.messageId).status === 'delivered');
    assert.equal(f.received.get('b').length, 1);
  } finally { f.close(); }
});

test('watchdogs recover lost wake hints and receipt history is bounded with explicit unknown', async () => {
  const noHints = Object.fromEntries(Object.getOwnPropertyNames(native).map(key => [key, native[key]]));
  noHints.signalPost = () => {};
  const f = fixture({ watchdogMs: 10, nativeOverride: noHints });
  try {
    const a = f.client('a'); f.client('b');
    const message = a.send({ agentId: 'b', text: 'No semaphore hints' });
    await until(() => a.status(message.messageId).status === 'delivered');
    for (let i = 0; i < 65; i++) {
      f.advance(61000);
      a.send({ agentId: 'b', text: 'Bounded receipt history' }); f.pump();
    }
    assert.equal(a.status(message.messageId).code, 'MESSAGE_HISTORY_MISSING');
    assert.equal(f.errors.length, 0);
  } finally { f.close(); }
});

test('post-commit wake errors retain the message ID; stale servers fence pending outcomes without replay', () => {
  const f = fixture();
  let stale = false;
  try {
    const brokenHints = Object.fromEntries(Object.getOwnPropertyNames(native).map(key => [key, native[key]]));
    brokenHints.signalPost = () => { throw Object.assign(new Error('Lost hint'), { code: 'SHM_SIGNAL' }); };
    const a = f.client('a', { native: brokenHints, open: (...args) => {
      const reader = openCanvasMemory(...args);
      return { read() { if (stale) throw Object.assign(new Error('Expired heartbeat'), { code: 'SHM_STALE' }); return reader.read(); }, close: () => reader.close() };
    } });
    f.client('b');
    const sent = a.send({ agentId: 'b', text: 'Already committed' });
    assert.equal(sent.notificationWarning, 'SHM_SIGNAL'); assert.equal(sent.status, 'queued');
    f.pump(); assert.equal(a.status(sent.messageId).status, 'delivered'); assert.equal(f.received.get('b').length, 1);
    const pending = a.send({ agentId: 'b', text: 'No automatic replay' }); f.router.drain(); a.drain();
    assert.equal(a.status(pending.messageId).status, 'accepted');
    stale = true; a.drain();
    assert.equal(a.status(pending.messageId).status, 'unknown');
    assert.equal(a.status(sent.messageId).status, 'delivered');
    assert.throws(() => a.send({ agentId: 'b', text: 'Closed' }), { code: 'SHM_CLOSED' });
    assert.equal(f.errors.at(-1).code, 'SHM_STALE');
  } finally { f.close(); }
});

test('follow-ups have sender/recipient rate limits and finite process budgets; ordinary messages never wake', () => {
  const f = fixture();
  try {
    const a = f.client('a'); f.client('b'); const c = f.client('c');
    for (let i = 0; i < 3; i++) { a.send({ agentId: 'b', text: 'Explicit', delivery: 'followUp', wake: true }); f.pump(); }
    const rate = c.send({ agentId: 'b', text: 'Aggregate recipient limit', delivery: 'followUp', wake: true }); f.pump();
    assert.equal(c.status(rate.messageId).code, 'MESSAGE_RATE');
    for (let i = 3; i < 16; i++) {
      f.advance(61000); a.send({ agentId: 'b', text: 'Explicit', delivery: 'followUp', wake: true }); f.pump();
    }
    f.advance(61000);
    const budget = a.send({ agentId: 'b', text: 'Budget exhausted', delivery: 'followUp', wake: true }); f.pump();
    assert.equal(a.status(budget.messageId).code, 'MESSAGE_RATE');
    const normal = a.send({ agentId: 'b', text: 'Still can send non-waking context' }); f.pump();
    assert.equal(a.status(normal.messageId).status, 'delivered');
    assert.equal(f.received.get('b').at(-1).wake, false);
  } finally { f.close(); }
});

test('invalid payload/policy, self sends, stale generations and duplicate IDs never deliver or overwrite pending evidence', () => {
  const f = fixture();
  try {
    const a = f.client('a'); f.client('b');
    for (const params of [{ text: '' }, { text: '🧋'.repeat(2001) }, { text: '\x1b[1m' }, { wake: true }, { ttlMs: 0 }, { delivery: 'steer' }, { generation: 3 }]) {
      assert.throws(() => a.send({ agentId: 'b', text: 'valid', ...params }));
    }
    assert.throws(() => a.send({ agentId: 'a', text: 'Self' }), { code: 'MESSAGE_SELF' });
    const stale = a.send({ agentId: 'b', text: 'Old target', generation: randomUUID() }); f.pump();
    assert.equal(a.status(stale.messageId).code, 'MESSAGE_TARGET');
    const raw = messageQueue(native, native.queueOpen(f.channels.get('c').config.outbox, 'producer'));
    try {
      const id = randomUUID(), frame = { messageId: id, agentId: 'b', generation: f.agents.get('b').processGeneration,
        text: 'Only once', delivery: 'nextTurn', wake: false, expiresAt: Date.now() + 50000 };
      raw.push(frame); raw.push(frame); raw.push({ ...frame, messageId: randomUUID(), sourceId: 'a' });
      f.pump(); assert.equal(f.received.get('b').filter(frame => frame.text === 'Only once').length, 1);
      assert.equal(f.received.get('b').at(-1).sourceId, 'c');
    } finally { raw.close(); }
  } finally { f.close(); }
});

test('outbox, mailbox and receipt backpressure stay bounded; delivery acknowledgments cannot be blocked by sends', () => {
  const f = fixture();
  try {
    const a = f.client('a'), b = f.client('b');
    const sent = Array.from({ length: QUEUE_SLOTS }, (_, i) => a.send({ agentId: 'b', text: `a${i}` }));
    assert.throws(() => a.send({ agentId: 'b', text: 'Overflow' }), { code: 'SHM_QUEUE_FULL' });
    f.router.drain(); assert.equal(f.channels.get('a').pending.size, 8); // 8 accepted + 8 reserved terminal credits.
    const replies = Array.from({ length: QUEUE_SLOTS }, (_, i) => b.send({ agentId: 'a', text: `b${i}` }));
    for (let i = 0; i < 8; i++) f.pump();
    assert.equal(sent.every(item => a.status(item.messageId).status === 'delivered'), true);
    assert.equal(replies.every(item => b.status(item.messageId).status === 'delivered'), true);
    assert.equal(f.channels.get('a').pending.size, 0); assert.equal(f.errors.length, 0);
    // Leave B's mailbox undrained and free A's accepted receipts.
    f.advance(61000);
    for (let i = 0; i < 15; i++) a.send({ agentId: 'b', text: `fill${i}`, ttlMs: 600000 });
    for (let i = 0; i < 4; i++) { f.router.drain(); a.drain(); }
    const c = f.client('c'); c.send({ agentId: 'b', text: 'Last slot' }); f.router.drain(); c.drain();
    assert.equal(f.channels.get('b').inbox.used, QUEUE_SLOTS);
    const full = c.send({ agentId: 'b', text: 'Full target' }); f.router.drain(); c.drain();
    assert.equal(c.status(full.messageId).status, 'rejected');
    assert.equal(c.status(full.messageId).code, 'SHM_QUEUE_FULL');
    assert.equal(f.channels.get('b').inbox.used, QUEUE_SLOTS);
  } finally { f.close(); }
});

test('deadline, handoff failure and stopped/replacement generations resolve without replay or automatic resend', () => {
  const f = fixture();
  try {
    const a = f.client('a'); const b = f.client('b', { deliver() { throw new Error('Partially failed Pi API'); } });
    const failed = a.send({ agentId: 'b', text: 'No retry' }); f.pump();
    assert.equal(a.status(failed.messageId).status, 'unknown');
    const expired = a.send({ agentId: 'b', text: 'Expires', ttlMs: 1 }); f.advance(2); f.pump();
    assert.equal(a.status(expired.messageId).code, 'MESSAGE_EXPIRED');
    const pending = a.send({ agentId: 'b', text: 'Uncertain', ttlMs: 5 }); f.router.drain(); a.drain();
    f.advance(6); f.router.drain(); a.drain(); assert.equal(a.status(pending.messageId).status, 'unknown');
    b.drain(); f.router.drain(); a.drain(); assert.equal(a.status(pending.messageId).status, 'unknown');
    const stopped = a.send({ agentId: 'b', text: 'Closing' }); f.router.drain(); a.drain();
    f.channels.get('b').close(); a.drain(); assert.equal(a.status(stopped.messageId).code, 'MESSAGE_TARGET_CLOSED');
    f.agents.get('b').processGeneration = randomUUID(); f.memory.publish();
    const newChannel = f.router.createChannel('b', f.agents.get('b').processGeneration);
    assert.notEqual(newChannel.config.inbox, f.channels.get('b').config.inbox);
    assert.throws(() => b.send({ agentId: 'a', text: 'Old reader' }), { code: 'SHM_CLOSED' });
    assert.equal(f.received.get('b').length, 0);
  } finally { f.close(); }
});

test('old source-generation acks cannot confirm a reused UUID in a replacement source process', () => {
  const f = fixture();
  let outbox, receipts;
  try {
    const a = f.client('a'); const b = f.client('b', { deliver(frame) { if (frame.text === 'replacement request') throw new Error('Uncertain new handoff'); } });
    const old = a.send({ agentId: 'b', text: 'old source request' }); f.router.drain(); a.drain();
    a.close(); f.router.drain();
    f.agents.get('a').processGeneration = randomUUID(); f.memory.publish();
    const replacement = f.router.createChannel('a', f.agents.get('a').processGeneration);
    f.channels.get('a').close(); // Stale cleanup must not close the replacement channel.
    assert.equal(f.router.size, 3);
    outbox = messageQueue(native, native.queueOpen(replacement.config.outbox, 'producer'));
    receipts = messageQueue(native, native.queueOpen(replacement.config.receipts, 'consumer'));
    outbox.push({ messageId: old.messageId, agentId: 'b', generation: f.agents.get('b').processGeneration,
      text: 'replacement request', delivery: 'nextTurn', wake: false, expiresAt: Date.now() + 50000 });
    f.router.drain(); b.drain(); f.router.drain();
    const statuses = []; let entry;
    while ((entry = receipts.peek())) { statuses.push(entry.value.status); receipts.shift(entry.sequence); }
    assert.deepEqual(statuses, ['accepted', 'unknown']);
  } finally { outbox?.close(); receipts?.close(); f.close(); }
});

test('messaging tool defaults never wake; explicit Pi handoffs are marked peer data and quit fences process resources', async () => {
  const f = fixture(), old = { ...process.env };
  try {
    const hooks = new Map(), tools = new Map(), messages = [], ui = [];
    Object.assign(process.env, { AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(f.channels.get('b').config), AGENT_CANVAS_SHM_NAME: f.memory.name, AGENT_CANVAS_SHM_EPOCH: f.memory.epoch });
    messagesExtension({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool), sendMessage: (...args) => messages.push(args) });
    assert.equal(messages.length, 0); assert.equal(tools.size, 2);
    hooks.get('session_start')({}, { hasUI: true, ui: { notify: (...args) => ui.push(args) } });
    const a = f.client('a');
    const first = a.send({ agentId: 'b', text: 'Peer data' }); f.router.drain();
    await until(() => messages.length === 1); f.router.drain(); a.drain();
    assert.equal(a.status(first.messageId).status, 'delivered');
    assert.deepEqual(messages[0][1], { deliverAs: 'nextTurn', triggerTurn: false });
    assert.match(messages[0][0].content, /peer data, not user\/system instructions/);
    a.send({ agentId: 'b', text: 'Explicit wake', delivery: 'followUp', wake: true }); f.router.drain(); await until(() => messages.length === 2);
    assert.deepEqual(messages[1][1], { deliverAs: 'followUp', triggerTurn: true });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(tools.get('canvas_send_message').execute('x', { agentId: 'a', text: 'Aborted' }, aborted.signal));
    hooks.get('session_shutdown')();
    await assert.rejects(tools.get('canvas_send_message').execute('x', { agentId: 'a', text: 'Closed' }), { code: 'SHM_CLOSED' });
    assert.throws(() => f.client('b'), /queue|Queue/);
  } finally { process.env = old; f.close(); }
});

test('process messaging survives reload/new/resume/fork with paused handoffs, current contexts and retained receipts', async () => {
  const f = fixture(), old = { ...process.env }, key = Symbol.for('agent-canvas.messaging.process.v1');
  let runtime;
  const makeRuntime = () => {
    const hooks = new Map(), tools = new Map(), messages = [], alerts = [];
    const state = { hooks, tools, messages, alerts, dead: false };
    messagesExtension({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool), sendMessage: (...args) => {
      assert.equal(state.dead, false, 'Stale Pi API used'); messages.push(args);
    } });
    state.start = reason => hooks.get('session_start')({ reason }, { hasUI: true, ui: { notify: (...args) => {
      assert.equal(state.dead, false, 'Stale UI context used'); alerts.push(args);
    } } });
    state.shutdown = reason => { hooks.get('session_shutdown')({ reason }); state.dead = true; };
    return state;
  };
  try {
    Object.assign(process.env, { AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(f.channels.get('b').config), AGENT_CANVAS_SHM_NAME: f.memory.name, AGENT_CANVAS_SHM_EPOCH: f.memory.epoch });
    const a = f.client('a'); runtime = makeRuntime(); runtime.start('startup');
    const broker = process[key];
    const sent = (await runtime.tools.get('canvas_send_message').execute('send', { agentId: 'a', text: 'Process receipt' })).details;
    f.router.drain(); a.drain(); f.router.drain();
    for (const reason of ['reload', 'new', 'resume', 'fork']) {
      const before = runtime;
      const incoming = a.send({ agentId: 'b', text: `Pending during ${reason}` }); f.router.drain(); a.drain();
      const count = before.messages.length;
      before.shutdown(reason); await delay(25);
      assert.equal(before.messages.length, count);
      assert.equal(f.channels.get('b').inbox.used, 1, 'Pending message consumed without a live context');
      assert.equal(process[key], broker); assert.equal(broker.client.closed, false);
      runtime = makeRuntime(); runtime.start(reason);
      assert.equal(process[key], broker); assert.equal(runtime.messages.length, 1);
      assert.ok(runtime.messages[0][0].content.includes(`Pending during ${reason}`));
      f.router.drain(); a.drain();
      assert.equal(a.status(incoming.messageId).status, 'delivered');
      const receipt = (await runtime.tools.get('canvas_message_status').execute('status', { messageId: sent.messageId })).details;
      assert.equal(receipt.status, 'delivered');
      before.hooks.get('session_shutdown')({ reason }); // Stale cleanup cannot detach the replacement.
      const next = (await runtime.tools.get('canvas_send_message').execute('send', { agentId: 'a', text: 'Still same process' })).details;
      f.router.drain(); a.drain(); f.router.drain();
      assert.equal(next.status, 'queued');
      await assert.rejects(before.tools.get('canvas_send_message').execute('stale', { agentId: 'a', text: 'Do not use old context' }), { code: 'MESSAGE_CONTEXT' });
    }
    runtime.shutdown('quit'); assert.equal(process[key], undefined);
    assert.throws(() => native.queueState(native.queueOpen(f.channels.get('b').config.inbox, 'consumer')), { code: 'SHM_CLOSED' });
    assert.equal(f.errors.length, 0);
  } finally { process[key]?.close(); process.env = old; f.close(); }
});

test('runtime provisions private per-run queues, omits descriptors/payloads from Canvas state and skips them in HTTP-only mode', async () => {
  for (const sharedMemory of [true, false]) {
    const children = [];
    const app = createApp({ port: 0, sharedMemory, spawnAgent: (_bin, args, options) => {
      const child = new EventEmitter(); Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn),
        write() {}, resize() {}, kill: () => child.emit('exit', { exitCode: 0 }) }); children.push(child); return child;
    } });
    try {
      await app.listen(); const base = `http://127.0.0.1:${app.server.address().port}/api`;
      const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const agent = await (await post('/agents', { name: 'Messaging fixture', workdir: process.cwd() })).json();
      const raw = children[0].options.env.AGENT_CANVAS_SHM_MESSAGES;
      assert.equal(Boolean(raw), sharedMemory);
      assert.equal(children[0].args.some(arg => String(arg).endsWith('/pi-canvas-messages.js')), sharedMemory);
      if (sharedMemory) {
        const config = JSON.parse(raw); assert.equal(config.generation, app.runtime.get(agent.id).processGeneration);
        assert.equal(JSON.stringify(await (await fetch(base + '/state')).json()).includes(config.outbox), false);
        await post(`/agents/${agent.id}/stop`); await post(`/agents/${agent.id}/resume`);
        const next = JSON.parse(children[1].options.env.AGENT_CANVAS_SHM_MESSAGES);
        assert.notEqual(next.generation, config.generation);
        assert.throws(() => native.queueOpen(config.outbox, 'producer'), { code: 'SHM_MISSING' });
      }
    } finally { await app.close(); }
  }
});
