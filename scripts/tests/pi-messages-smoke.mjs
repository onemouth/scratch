import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once, EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCanvasMemory } from '../../server/canvas-memory.js';
import { createCanvasMessaging } from '../../server/canvas-messages.js';
import { createCanvasTelemetry } from '../../server/canvas-telemetry.js';

const directory = await mkdtemp(join(tmpdir(), 'canvas-messages-pi-'));
const state = { agents: ['a', 'b'].map(id => ({ id, name: id, status: 'running', activity: 'idle', processGeneration: randomUUID() })), edges: [], notes: [], cards: [], cardPlacements: [] };
const memory = createCanvasMemory({ getState: () => state });
const errors = [];
const router = createCanvasMessaging({ epoch: memory.epoch, getAgent: id => state.agents.find(agent => agent.id === id), onError: error => errors.push(error) });
const telemetryReports = [], telemetryBus = new EventEmitter();
const telemetry = createCanvasTelemetry({ epoch: memory.epoch, onError: error => errors.push(error), apply(id, generation, frame) {
  assert.equal(generation, state.agents.find(agent => agent.id === id).processGeneration);
  telemetryReports.push({ id, ...frame }); telemetryBus.emit('report');
} });
function waitReport(predicate) {
  if (telemetryReports.some(predicate)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); telemetryBus.off('report', check); error ? reject(error) : resolve(); };
    const check = () => { if (telemetryReports.some(predicate)) done(); };
    const timer = setTimeout(() => done(new Error('Telemetry report timeout')), 15000);
    telemetryBus.on('report', check);
  });
}
const peers = [];
function waitFor(peer, predicate, after = 0) {
  const existing = peer.events.slice(after).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const finish = (error, event) => { clearTimeout(timer); peer.bus.off('event', check); error ? reject(error) : resolve(event); };
    const check = event => {
      if (peer.failure) return finish(peer.failure);
      if (predicate(event)) finish(null, event);
    };
    const timer = setTimeout(() => finish(new Error(`Pi ${peer.id} timed out: ${peer.stderr}`)), 15000);
    peer.bus.on('event', check);
  });
}
const notify = (peer, prefix, after = 0) => waitFor(peer, event => event.type === 'extension_ui_request' && event.message?.startsWith(prefix), after);
function command(peer, id, message) { peer.child.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n'); }
try {
  for (const agent of state.agents) {
    const cwd = join(directory, agent.id); await mkdir(cwd);
    const channel = router.createChannel(agent.id, agent.processGeneration);
    const telemetryChannel = telemetry.createChannel(agent.id, agent.processGeneration);
    const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--extension', fileURLToPath(new URL('./pi-messages-extension.js', import.meta.url))], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: cwd, AGENT_CANVAS_URL: '', AGENT_CANVAS_ID: agent.id,
        AGENT_CANVAS_SHM_NAME: memory.name, AGENT_CANVAS_SHM_EPOCH: memory.epoch, AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(channel.config),
        AGENT_CANVAS_SHM_TELEMETRY: JSON.stringify(telemetryChannel.config) },
    });
    const peer = { id: agent.id, child, events: [], bus: new EventEmitter(), stderr: '', failure: null };
    peers.push(peer); peer.exit = once(child, 'exit'); peer.exit.catch(() => {});
    child.stderr.on('data', data => { peer.stderr += data; });
    child.on('error', error => { peer.failure = error; peer.bus.emit('event', {}); });
    child.on('exit', code => { peer.failure ??= new Error(`Pi ${agent.id} exited (${code}): ${peer.stderr}`); peer.bus.emit('event', {}); });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'agent_start') peer.failure = new Error('Messaging smoke must never start an LLM');
        if (event.type === 'response' && event.success === false) peer.failure = new Error(JSON.stringify(event));
        if (event.type === 'extension_error') peer.failure = new Error(JSON.stringify(event));
        peer.events.push(event); peer.bus.emit('event', event);
      } catch (error) { peer.failure = error; peer.bus.emit('event', {}); }
    });
  }
  await Promise.all(peers.map(peer => notify(peer, 'SHM_MESSAGE_READY')));
  const [a, b] = peers;
  let sequence = 0;
  async function exchange(source, target, label, options = {}) {
    const sourceStart = source.events.length, targetStart = target.events.length;
    const text = `${source.id}-to-${target.id} ${label} 跨程序 🧋`;
    command(source, `send-${++sequence}`, '/message-smoke ' + JSON.stringify({ agentId: target.id, text, ...options }));
    const sent = JSON.parse((await notify(source, 'SHM_MESSAGE_SENT:', sourceStart)).message.slice('SHM_MESSAGE_SENT:'.length));
    assert.equal(sent.status, 'queued');
    const inbound = JSON.parse((await notify(target, 'SHM_MESSAGE_INBOUND:', targetStart)).message.slice('SHM_MESSAGE_INBOUND:'.length));
    assert.ok(inbound.message.content.includes(text));
    assert.equal(inbound.message.details.sourceId, source.id);
    assert.equal(inbound.message.details.sourceGeneration, state.agents.find(agent => agent.id === source.id).processGeneration);
    assert.deepEqual(inbound.options, { deliverAs: options.delivery ?? 'nextTurn', triggerTurn: false });
    await waitFor(source, event => event.type === 'extension_ui_request' && event.message === `Canvas message ${sent.messageId}: delivered`);
    const statusStart = source.events.length;
    command(source, `status-${sequence}`, '/message-status ' + sent.messageId);
    const status = JSON.parse((await notify(source, 'SHM_MESSAGE_STATUS:', statusStart)).message.slice('SHM_MESSAGE_STATUS:'.length));
    assert.equal(status.messageId, sent.messageId); assert.equal(status.status, 'delivered');
    return { sent, inbound };
  }
  async function progress(peer, label) {
    const start = peer.events.length, value = `Owned telemetry ${label} 🧋`;
    command(peer, `progress-${++sequence}`, '/telemetry-smoke ' + value);
    const sent = JSON.parse((await notify(peer, 'SHM_TELEMETRY_SENT:', start)).message.slice('SHM_TELEMETRY_SENT:'.length));
    assert.equal(sent.status, 'queued');
    await waitReport(frame => frame.id === peer.id && frame.seq === sent.seq && frame.kind === 'progress' && frame.data.text === value);
    const statusStart = peer.events.length;
    command(peer, `telemetry-status-${sequence}`, '/telemetry-status ' + sent.seq);
    const status = JSON.parse((await notify(peer, 'SHM_TELEMETRY_STATUS:', statusStart)).message.slice('SHM_TELEMETRY_STATUS:'.length));
    assert.equal(status.status, 'applied');
    return sent;
  }
  const initialProgress = await progress(a, 'startup');
  await Promise.all(peers.map(peer => waitReport(frame => frame.id === peer.id && frame.kind === 'activity' && frame.data.state === 'idle')));
  const original = await exchange(a, b, 'initial');
  await exchange(b, a, 'initial reply', { delivery: 'followUp', wake: false });
  const fixtureFile = join(directory, 'resume-fixture.jsonl');
  const timestamp = new Date().toISOString();
  await writeFile(fixtureFile, [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: join(directory, 'a') },
    { type: 'message', id: 'a1b2c3d4', parentId: null, timestamp, message: { role: 'user', content: 'Owned no-LLM fork fixture', timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const start = a.events.length;
    const lastTelemetrySeq = telemetryReports.filter(frame => frame.id === 'a').at(-1).seq;
    if (reason === 'reload') command(a, 'reload', '/message-reload');
    else a.child.stdin.write(JSON.stringify(reason === 'new' ? { id: 'new', type: 'new_session' }
      : reason === 'resume' ? { id: 'resume', type: 'switch_session', sessionPath: fixtureFile }
        : { id: 'fork', type: 'fork', entryId: 'a1b2c3d4' }) + '\n');
    await notify(a, `SHM_MESSAGE_DETACHED:${reason}`, start);
    // Enqueue during the real shutdown/start handoff, not only after startup.
    const pending = exchange(b, a, `during ${reason}`);
    await notify(a, `SHM_MESSAGE_READY:${reason}`, start);
    const context = JSON.parse((await notify(a, 'SHM_TELEMETRY_CONTEXT:', start)).message.slice('SHM_TELEMETRY_CONTEXT:'.length));
    assert.equal(context.reason, reason);
    await waitReport(frame => frame.id === 'a' && frame.kind === 'session' && frame.seq > lastTelemetrySeq && frame.data.sessionId === context.sessionId && frame.data.sessionFile === context.sessionFile);
    const statusStart = a.events.length;
    command(a, `old-telemetry-${reason}`, '/telemetry-status ' + initialProgress.seq);
    const retained = JSON.parse((await notify(a, 'SHM_TELEMETRY_STATUS:', statusStart)).message.slice('SHM_TELEMETRY_STATUS:'.length));
    assert.equal(retained.status, 'applied');
    await progress(a, reason);
    const result = await pending;
    assert.equal(result.inbound.contextReason, reason, 'Message used a stale Pi API');
    const receiptStart = a.events.length;
    command(a, `old-receipt-${reason}`, '/message-status ' + original.sent.messageId);
    const receipt = JSON.parse((await notify(a, 'SHM_MESSAGE_STATUS:', receiptStart)).message.slice('SHM_MESSAGE_STATUS:'.length));
    assert.equal(receipt.status, 'delivered', 'Process receipt history was lost on session replacement');
    await exchange(a, b, `after ${reason}`);
  }
  for (const peer of peers) {
    assert.equal(peer.failure, null);
    assert.equal(peer.events.some(event => event.type === 'agent_start'), false);
    assert.equal(peer.events.some(event => /Canvas telemetry (unavailable|report not queued)/.test(event.message ?? '')), false);
    const reports = telemetryReports.filter(frame => frame.id === peer.id);
    assert.ok(reports.every((frame, index) => index === 0 || frame.seq > reports[index - 1].seq));
    peer.child.stdin.end();
  }
  const timeout = setTimeout(() => { for (const peer of peers) peer.child.kill('SIGKILL'); }, 3000);
  try { for (const peer of peers) assert.equal((await peer.exit)[0], 0); }
  finally { clearTimeout(timeout); }
  assert.deepEqual(errors, []);
  console.log('Two real Pi processes exchanged SHM messages/receipts across reload, new, resume and fork, including messages queued during handoff and retained receipt history. Actual current-context Pi API handoffs; no HTTP or LLM run. Dedicated telemetry also reported real current session identity/activity/progress with monotonic process sequences and retained receipts across all four transitions. Only disposable fixture sessions, removed after test.');
} finally {
  for (const peer of peers) if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill('SIGKILL');
  await Promise.allSettled(peers.map(peer => peer.exit));
  telemetry.close(); router.close(); memory.close(); await rm(directory, { recursive: true, force: true });
}
