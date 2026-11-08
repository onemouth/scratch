import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createAgentInbox } from './agent-inbox.js';
import { createInboxObserver as createObserver, inboxMessageContent, INBOX_PER_AGENT, INBOX_TOTAL } from '../shared/canvas-inbox.js';
import { createCanvasMemory } from './canvas-memory.js';
import { createCanvasMessaging } from './canvas-messages.js';
import { createCanvasMessageClient } from './canvas-message-client.js';
import { createApp } from './index.js';
import messagesExtension from './pi-canvas-messages.js';

// Unit contexts include the outgoing payload check; the separate real-Pi smoke
// exercises the actual hooks and provider conversion, without external model/network calls.
const createInboxObserver = () => {
  const observer = createObserver(), context = observer.context;
  return { ...observer, context(messages) { context(messages); observer.request({ messages }); } };
};
const frame = (extra = {}) => ({ messageId: randomUUID(), sourceId: 'source', sourceGeneration: randomUUID(), text: '待處理 🧋', ...extra });
const custom = value => ({ role: 'custom', customType: 'canvas-agent-message', content: inboxMessageContent(value),
  details: { messageId: value.messageId, sourceId: value.sourceId, sourceGeneration: value.sourceGeneration } });
const response = (type = 'message_update', stopReason = 'stop') => ({ type, message: { role: 'assistant', stopReason },
  assistantMessageEvent: { type: 'text_delta', delta: 'response' } });
const ready = observer => { const report = observer.report(); observer.committed(report); return report; };

test('B observes exact peer messages in a responding model context, not API handoff or context preparation alone', () => {
  const observer = createInboxObserver(), a = frame(), b = frame();
  assert.deepEqual(ready(observer), { kind: 'inbox', version: 1, seq: 1, ready: true, ids: [] });
  observer.track(a); observer.track(b);
  assert.equal(observer.report(), null); // A is not B.
  observer.context([custom(a)]);
  assert.equal(observer.report(), null); // A request might still fail before any response.
  observer.response({ type: 'message_start', message: { role: 'assistant' } });
  assert.equal(observer.report(), null); // Start may be a synthetic error.
  observer.response(response());
  assert.deepEqual(ready(observer).ids, [a.messageId]);
  assert.equal(observer.report(), null);
  observer.context([custom(a), custom(b)]); observer.response(response('message_end'));
  assert.deepEqual(ready(observer).ids, [b.messageId]); // No repeated consumption from history.
});

test('errors, abort, context filtering, wrong identity and detached sessions never imply inclusion', () => {
  for (const stopReason of ['error', 'aborted']) {
    const observer = createInboxObserver(), a = frame(); ready(observer); observer.track(a);
    observer.context([custom(a)]); observer.response(response('message_end', stopReason));
    observer.response(response()); assert.equal(observer.report(), null);
    observer.context([custom(a)]); observer.resetContext();
    assert.deepEqual(ready(observer).uncertainIds, [a.messageId]);
    observer.response(response()); assert.equal(observer.report(), null);
    observer.context([custom(a)]); observer.context([]); observer.response(response()); assert.equal(observer.report(), null);
    for (const value of [
      { ...custom(a), content: 'different text' },
      { ...custom(a), role: 'user' },
      { ...custom(a), customType: 'another-extension' },
      { ...custom(a), details: { ...custom(a).details, sourceGeneration: randomUUID() } },
    ]) { observer.context([value]); observer.response(response()); assert.equal(observer.report(), null); }
    observer.context([custom(a)]); observer.response(response()); assert.deepEqual(ready(observer).ids, [a.messageId]);
  }
});

test('outgoing payload must contain the exact envelope; unrelated/new arrivals are not consumed by another response', () => {
  const observer = createObserver(), a = frame(), b = frame(); ready(observer); observer.track(a);
  observer.context([custom(a)]); observer.response(response()); assert.equal(observer.report(), null);
  observer.context([custom(a)]); observer.request({ messages: [] }); observer.response(response()); assert.equal(observer.report(), null);
  observer.context([custom(a)]); observer.request({ text: a.messageId }); observer.response(response()); assert.equal(observer.report(), null);
  observer.context([custom(a)]); observer.request({ input: [{ text: 'prefix ' + custom(a).content }] });
  observer.track(b); observer.response(response()); assert.deepEqual(ready(observer).ids, [a.messageId]);
  observer.resetContext(); assert.deepEqual(ready(observer).uncertainIds, [b.messageId]);
});

test('observer is bounded and coalesces inclusion facts in sequenced one-KiB batches', () => {
  const observer = createInboxObserver(), frames = Array.from({ length: INBOX_PER_AGENT }, () => frame());
  ready(observer); frames.forEach(value => observer.track(value));
  assert.throws(() => observer.track(frame()), /capacity/);
  observer.context(frames.map(custom)); observer.response(response());
  const ids = []; let seq = 1;
  for (let report; (report = observer.report());) {
    assert.equal(report.seq, ++seq); assert.ok(report.ids.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1024);
    assert.deepEqual(observer.report(), report); // No advancement before native commit.
    ids.push(...report.ids); observer.committed(report);
  }
  assert.deepEqual(ids, frames.map(value => value.messageId));
});

function storeFixture() {
  const agents = new Map([['source', { name: 'Sender' }], ['target', { status: 'running' }]]);
  let changes = 0;
  const store = createAgentInbox({ getAgent: id => agents.get(id), onChange: () => changes++, now: () => 123 });
  store.open('target', 'generation');
  const observe = (seq, ids = [], extra = {}) => store.observe('target', 'generation', { kind: 'inbox', version: 1, ready: true, seq, ids, ...extra });
  return { store, observe, agents, changes: () => changes };
}

test('read-only inbox keeps delivered/uncertain items, removes expired/included IDs, and never exposes text in summaries', () => {
  const { store, observe, changes } = storeFixture();
  assert.equal(store.summary('target').count, null); observe(1);
  const a = frame(), b = frame(), c = frame(); [a, b, c].forEach(value => store.add('target', 'generation', value));
  store.handoff('target', 'generation', a.messageId, 'delivered');
  store.handoff('target', 'generation', b.messageId, 'unknown');
  store.handoff('target', 'generation', c.messageId, 'expired');
  const before = changes(), view = store.read('target');
  assert.equal(view.count, 2); assert.equal(view.messages[0].sourceName, 'Sender');
  assert.equal(view.messages[0].receivedAt, 123); assert.equal(view.messages[1].state, 'uncertain');
  view.messages[0].text = 'mutated'; assert.equal(store.read('target').messages[0].text, a.text);
  assert.equal(changes(), before); assert.ok(!JSON.stringify(store.summary('target')).includes(a.text));
  observe(2, [a.messageId]); assert.equal(store.summary('target').count, 1);
  observe(3, [a.messageId]); assert.equal(store.summary('target').count, 1); // Idempotent facts, not message replay.
});

test('process close is unavailable, a replacement never receives old entries, and removed nodes release retained text', () => {
  const { store, observe, agents } = storeFixture(); observe(1);
  const a = frame(); store.add('target', 'generation', a);
  store.close('target', 'generation');
  assert.equal(store.summary('target').state, 'unavailable'); assert.equal(store.summary('target').count, null);
  assert.equal(store.read('target').messages.length, 1);
  store.open('target', 'replacement');
  assert.equal(store.summary('target').previousUnconfirmed, true);
  assert.equal(store.read('target').messages.length, 0);
  observe(2, [a.messageId]); assert.equal(store.summary('target').state, 'unavailable'); // Old generation cannot revive.
  store.observe('target', 'replacement', { kind: 'inbox', version: 1, seq: 1, ready: true, ids: [] });
  assert.equal(store.summary('target').state, 'active'); assert.equal(store.summary('target').previousUnconfirmed, true);
  agents.delete('target'); assert.equal(store.read('target').generation, null);
});

test('invalid observations fence counts instead of clearing records or guessing empty; IDs are scoped to their recipient', () => {
  for (const invalid of [{ seq: 3 }, { seq: 1 }, { version: 2 }, { ids: ['not-a-uuid'] }, { surprise: true }]) {
    const { store, observe } = storeFixture(); observe(1); const a = frame(); store.add('target', 'generation', a);
    observe(2, [a.messageId], invalid);
    assert.equal(store.summary('target').state, 'unavailable'); assert.equal(store.read('target').messages.length, 1);
    observe(2, [a.messageId]); assert.equal(store.read('target').messages.length, 1);
  }
  const { store, observe, agents } = storeFixture(); observe(1); const a = frame(); store.add('target', 'generation', a);
  agents.set('other', { status: 'running' }); store.open('other', 'other-generation');
  store.observe('other', 'other-generation', { kind: 'inbox', version: 1, seq: 1, ready: true, ids: [a.messageId] });
  assert.equal(store.read('target').count, 1);
});

test('pending projection has per-process and total bounds; reads do not free capacity', () => {
  const { store, agents } = storeFixture();
  for (let i = 0; i < INBOX_TOTAL / INBOX_PER_AGENT; i++) {
    const id = `target-${i}`; agents.set(id, {}); store.open(id, 'generation');
    for (let j = 0; j < INBOX_PER_AGENT; j++) {
      assert.equal(store.capacity(id, 'generation'), true); store.add(id, 'generation', frame());
    }
    assert.equal(store.capacity(id, 'generation'), false); store.read(id);
    assert.equal(store.capacity(id, 'generation'), false);
  }
  assert.equal(store.capacity('target', 'generation'), false);
  agents.delete('target-0'); assert.equal(store.capacity('target', 'generation'), true);
});

test('real SHM A stays visible beyond handoff TTL; B clears only through recipient observation, not sender receipt', () => {
  const agents = new Map(['a', 'b'].map(id => [id, { id, name: id, status: 'running', processGeneration: randomUUID() }]));
  let time = Date.now();
  const memory = createCanvasMemory({ getState: () => ({ agents: [...agents.values()], edges: [], notes: [], cards: [], cardPlacements: [] }) });
  const router = createCanvasMessaging({ epoch: memory.epoch, getAgent: id => agents.get(id), now: () => time });
  const clients = [], frames = [];
  let canDeliver = true;
  try {
    for (const agent of agents.values()) {
      const channel = router.createChannel(agent.id, agent.processGeneration);
      clients.push(createCanvasMessageClient({ config: channel.config, name: memory.name, epoch: memory.epoch, now: () => time, canDeliver: () => canDeliver, deliver: value => frames.push(value) }));
    }
    const pump = () => { router.drain(); clients.forEach(client => client.drain()); router.drain(); clients.forEach(client => client.drain()); };
    pump(); assert.equal(router.inbox.summary('b').state, 'active');
    const sent = clients[0].send({ agentId: 'b', text: 'A ≠ B' }); pump();
    assert.equal(clients[0].status(sent.messageId).status, 'delivered'); assert.equal(router.inbox.summary('b').count, 1);
    time += 70000; pump(); assert.equal(router.inbox.summary('b').count, 1); // TTL governs handoff, not Pi's nextTurn queue.
    clients[1].observeContext(frames.map(custom)); clients[1].observeInboxRequest({ messages: frames.map(custom) });
    assert.equal(router.inbox.summary('b').count, 1);
    clients[1].observeResponse(response('message_end', 'error')); pump(); assert.equal(router.inbox.summary('b').count, 1);
    clients[1].observeContext(frames.map(custom)); clients[1].observeInboxRequest({ messages: frames.map(custom) });
    clients[1].observeResponse(response()); pump();
    assert.equal(router.inbox.summary('b').count, 0); assert.equal(clients[0].status(sent.messageId).status, 'delivered');
    canDeliver = false;
    const expired = clients[0].send({ agentId: 'b', text: 'expires before Pi handoff', ttlMs: 1 }); pump();
    time += 2000; pump();
    assert.equal(clients[0].status(expired.messageId).status, 'unknown');
    assert.equal(router.inbox.read('b').messages[0].state, 'uncertain');
    canDeliver = true; pump();
    assert.equal(router.inbox.summary('b').count, 0, 'Late expiry proof clears a never-handed message even after ACK_TIMEOUT');
    for (let i = 0; i < INBOX_PER_AGENT; i++) {
      if (i % 25 === 0) time += 60001; // Preserve the independent 30/min source limit.
      const queued = clients[0].send({ agentId: 'b', text: `nextTurn waiting ${i}` }); pump();
      assert.equal(clients[0].status(queued.messageId).status, 'delivered');
    }
    const beforeOverflow = frames.length;
    const overflow = clients[0].send({ agentId: 'b', text: 'must not silently replace a pending row' }); pump();
    assert.equal(clients[0].status(overflow.messageId).code, 'MESSAGE_INBOX_FULL');
    assert.equal(frames.length, beforeOverflow); assert.equal(router.inbox.summary('b').count, INBOX_PER_AGENT);
    agents.get('b').status = 'stopped'; router.close();
    assert.equal(router.inbox.read('b').state, 'unavailable'); assert.equal(router.inbox.read('b').messages.length, INBOX_PER_AGENT);
  } finally { clients.forEach(client => client.close()); router.close(); memory.close(); }
});

test('extension reload on an older process-owned broker keeps messaging usable without pretending tracking exists', async () => {
  const key = Symbol.for('agent-canvas.messaging.process.v1');
  const saved = Object.fromEntries(['AGENT_CANVAS_SHM_MESSAGES', 'AGENT_CANVAS_SHM_NAME', 'AGENT_CANVAS_SHM_EPOCH'].map(key => [key, process.env[key]]));
  const config = { version: 1, epoch: 'fixture-epoch' }, name = 'fixture-name';
  const broker = { fingerprint: JSON.stringify({ config, name, epoch: config.epoch }), binding: null, closed: false,
    client: { drain() {}, send() { return { status: 'queued', messageId: 'legacy-fixture' }; } },
    close() { broker.closed = true; broker.binding = null; } };
  const handlers = new Map(), tools = new Map();
  try {
    assert.equal(process[key], undefined); process[key] = broker;
    Object.assign(process.env, { AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(config), AGENT_CANVAS_SHM_NAME: name, AGENT_CANVAS_SHM_EPOCH: config.epoch });
    messagesExtension({ on: (type, handler) => handlers.set(type, handler), registerTool: tool => tools.set(tool.name, tool) });
    handlers.get('session_start')({}, {});
    assert.equal((await tools.get('canvas_send_message').execute('fixture', { agentId: 'peer', text: 'test' })).details.status, 'queued');
    assert.doesNotThrow(() => handlers.get('context_with_system')({ messages: [] }));
    assert.doesNotThrow(() => handlers.get('before_provider_request')({ payload: {} }));
    assert.doesNotThrow(() => handlers.get('message_end')(response('message_end')));
    assert.equal(typeof broker.client.observeContext, 'undefined');
    handlers.get('session_shutdown')({ reason: 'reload' }); assert.equal(broker.closed, false);
  } finally {
    delete process[key];
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('HTTP inbox is a read-only payload-on-demand view; live counts are ephemeral and browser reads send no terminal input', async () => {
  const children = [], envs = [];
  const app = createApp({ port: 0, spawnAgent(_command, _args, options) {
    const events = new EventEmitter(); envs.push(options.env);
    const child = { pid: -1, writes: [], write(value) { child.writes.push(value); }, resize() {}, kill() { events.emit('exit', { exitCode: 0 }); },
      onData(fn) { events.on('data', fn); }, onExit(fn) { events.on('exit', fn); } };
    children.push(child); return child;
  } });
  const clients = [];
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, method = 'GET', body) => fetch(base + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  try {
    const a = await (await call('/api/agents', 'POST', { name: 'Sender', workdir: process.cwd() })).json();
    const b = await (await call('/api/agents', 'POST', { name: 'Receiver', workdir: process.cwd() })).json();
    assert.equal((await (await call(`/api/agents/${b.id}/inbox`)).json()).state, 'unavailable');
    for (const env of envs) clients.push(createCanvasMessageClient({ config: JSON.parse(env.AGENT_CANVAS_SHM_MESSAGES), name: env.AGENT_CANVAS_SHM_NAME, epoch: env.AGENT_CANVAS_SHM_EPOCH, deliver() {} }));
    const sent = clients[0].send({ agentId: b.id, text: '<script>private inbox only</script> 🧋' });
    let detail;
    for (let i = 0; i < 100; i++) {
      detail = await (await call(`/api/agents/${b.id}/inbox`)).json();
      if (detail.messages.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(detail.messages[0].messageId, sent.messageId); assert.equal(detail.messages[0].sourceName, 'Sender');
    const writes = children.map(child => [...child.writes]);
    const again = await (await call(`/api/agents/${b.id}/inbox`)).json(); assert.deepEqual(again, detail);
    assert.deepEqual(children.map(child => child.writes), writes);
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await call(`/api/agents/${b.id}/inbox`, method, {})).status, 405);
    assert.equal((await call('/api/agents/missing/inbox')).status, 404);
    const state = await (await call('/api/state')).json();
    assert.ok(!JSON.stringify(state).includes('private inbox only')); assert.ok(state.agents.find(agent => agent.id === b.id).inbox.count > 0);
    assert.ok(app.snapshot(false).agents.every(agent => !Object.hasOwn(agent, 'inbox')));
    await call(`/api/agents/${b.id}/stop`, 'POST', {});
    assert.equal((await (await call(`/api/agents/${b.id}/inbox`)).json()).state, 'unavailable');
    await call(`/api/agents/${b.id}/resume`, 'POST', {});
    const replacement = await (await call(`/api/agents/${b.id}/inbox`)).json();
    assert.equal(replacement.previousUnconfirmed, true); assert.equal(replacement.messages.length, 0);
  } finally { clients.forEach(client => client.close()); await app.close(); }
});
