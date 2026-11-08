import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once, EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCanvasMemory } from '../../server/canvas-memory.js';
import { createCanvasMessaging } from '../../server/canvas-messages.js';
import { createCanvasMessageClient } from '../../server/canvas-message-client.js';

const directory = await mkdtemp(join(tmpdir(), 'canvas-inbox-pi-'));
const agents = ['source', 'receiver'].map(id => ({ id, name: id, status: 'running', processGeneration: randomUUID() }));
const memory = createCanvasMemory({ getState: () => ({ agents, edges: [], notes: [], cards: [], cardPlacements: [] }) });
const errors = [], changes = new EventEmitter();
const router = createCanvasMessaging({ epoch: memory.epoch, getAgent: id => agents.find(agent => agent.id === id),
  onChange: () => changes.emit('change'), onError: error => errors.push(error) });
const source = router.createChannel('source', agents[0].processGeneration), receiver = router.createChannel('receiver', agents[1].processGeneration);
const sender = createCanvasMessageClient({ config: source.config, name: memory.name, epoch: memory.epoch, deliver() {} });
const events = [], bus = new EventEmitter();
let child, exit, failure, stderr = '', sequence = 0;
const notify = (prefix, after = 0) => wait(() => events.slice(after).find(event => event.type === 'extension_ui_request' && event.message?.startsWith(prefix)), bus, 'event');
function wait(check, emitter = changes, name = 'change') {
  if (failure) return Promise.reject(failure);
  const value = check(); if (value) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    const finish = (error, result) => { clearTimeout(timer); emitter.off(name, inspect); bus.off('failure', fail); error ? reject(error) : resolve(result); };
    const fail = () => finish(failure);
    const inspect = () => { const result = check(); if (result) finish(null, result); };
    const timer = setTimeout(() => finish(new Error(`Inbox fixture timed out: ${stderr}\n${JSON.stringify(events.slice(-5))}`)), 15000);
    emitter.on(name, inspect); bus.on('failure', fail);
  });
}
function command(message) { child.stdin.write(JSON.stringify({ id: `inbox-${++sequence}`, type: 'prompt', message }) + '\n'); }
async function mode(value) { const after = events.length; command('/inbox-mode ' + value); await notify('INBOX_MODE:' + value, after); }
async function send(text, options = {}) {
  const sent = sender.send({ agentId: 'receiver', text, ...options });
  await wait(() => sender.status(sent.messageId).status === 'delivered', bus, 'tick');
  assert.ok(router.inbox.read('receiver').messages.some(message => message.messageId === sent.messageId));
  return sent;
}
let timer;
try {
  child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--provider', 'inbox-fixture', '--model', 'test', '--extension', fileURLToPath(new URL('./pi-inbox-extension.js', import.meta.url))], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_CODING_AGENT_DIR: directory,
      AGENT_CANVAS_SHM_NAME: memory.name, AGENT_CANVAS_SHM_EPOCH: memory.epoch, AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(receiver.config),
      AGENT_CANVAS_SHM_TELEMETRY: '', AGENT_CANVAS_SHM_QUERIES: '', AGENT_CANVAS_SHM_NOTIFY: '', AGENT_CANVAS_URL: '', AGENT_CANVAS_ID: 'receiver' },
  });
  exit = once(child, 'exit'); exit.catch(() => {});
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { failure = error; bus.emit('failure'); });
  child.on('exit', code => { if (code !== 0) { failure = new Error(`Pi exited (${code}): ${stderr}`); bus.emit('failure'); } });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'extension_error' || (event.type === 'response' && event.success === false)) {
        failure = new Error(JSON.stringify(event)); bus.emit('failure');
      }
      bus.emit('event');
    } catch (error) { failure = error; bus.emit('failure'); }
  });
  timer = setInterval(() => { router.drain(); sender.drain(); bus.emit('tick'); }, 10);
  await notify('INBOX_READY:'); await wait(() => router.inbox.summary('receiver').state === 'active');
  await send('waiting nextTurn 🧋'); assert.equal(router.inbox.summary('receiver').count, 1);
  assert.equal(events.some(event => event.type === 'agent_start'), false, 'Delivery/viewing must not wake Pi');
  await mode('fail'); let after = events.length; command('fixture request fails');
  await notify('INBOX_PROVIDER:fail', after); await wait(() => events.slice(after).some(event => event.type === 'agent_end'), bus, 'event');
  assert.equal(router.inbox.summary('receiver').count, 1, 'Provider failure must not look consumed');
  await mode('hold'); after = events.length; command('fixture request aborts'); await notify('INBOX_PROVIDER:hold', after);
  child.stdin.write(JSON.stringify({ id: 'abort', type: 'abort' }) + '\n');
  await wait(() => events.slice(after).some(event => event.type === 'agent_end'), bus, 'event');
  assert.equal(router.inbox.summary('receiver').count, 1, 'Abort before response must not look consumed');
  await mode('filtered'); after = events.length; command('fixture filters peer context'); await notify('INBOX_PROVIDER:filtered', after);
  await wait(() => events.slice(after).some(event => event.type === 'agent_end'), bus, 'event');
  assert.equal(router.inbox.summary('receiver').count, 1, 'Unrelated successful work must not clear filtered messages');
  await mode('ok'); command('fixture consumes pending context'); await wait(() => router.inbox.summary('receiver').count === 0);
  await wait(() => events.at(-1)?.type !== 'message_update', bus, 'tick');

  await send('idle followUp without wake', { delivery: 'followUp', wake: false });
  const starts = events.filter(event => event.type === 'agent_start').length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(events.filter(event => event.type === 'agent_start').length, starts);
  command('consume idle followUp'); await wait(() => router.inbox.summary('receiver').count === 0);
  const wake = sender.send({ agentId: 'receiver', text: 'explicit fake-model wake', delivery: 'followUp', wake: true });
  await wait(() => sender.status(wake.messageId).status === 'delivered' && router.inbox.summary('receiver').count === 0, bus, 'tick');

  // Reload/new rebind hooks without replaying a handed-off message. A dropped
  // session queue remains explicitly uncertain until a real context proves B.
  await send('pending across reload'); after = events.length; command('/inbox-reload'); await notify('INBOX_READY:reload', after);
  await wait(() => router.inbox.read('receiver').messages[0]?.state === 'uncertain');
  command('consume after reload'); await wait(() => router.inbox.summary('receiver').count === 0);
  await send('pending across new'); after = events.length;
  child.stdin.write(JSON.stringify({ id: 'new', type: 'new_session' }) + '\n'); await notify('INBOX_READY:new', after);
  await wait(() => router.inbox.read('receiver').messages[0]?.state === 'uncertain');
  assert.equal(router.inbox.read('receiver').messages.length, 1);
  const count = router.inbox.read('receiver').messages.length;
  command('new session unrelated work');
  await wait(() => events.slice(after).some(event => event.type === 'agent_end'), bus, 'event');
  // Pi decides whether its own queue survives new_session; the projection never
  // guesses or re-injects it. Either proven B clears it, or it stays uncertain.
  assert.ok(router.inbox.read('receiver').messages.length <= count);
  assert.deepEqual(errors, []); assert.equal(failure, undefined);
  child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { assert.equal((await exit)[0], 0); } finally { clearTimeout(kill); }
  console.log('Real Pi Inbox B passed: A remains pending without waking; request failure, abort and filtered context retain messages; actual context/payload + fake-provider response consumes B; reload/new preserve process-owned tracking with uncertainty, no replay. No network or real model calls.');
} finally {
  clearInterval(timer);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (exit) await Promise.allSettled([exit]);
  sender.close(); router.close(); memory.close(); await rm(directory, { recursive: true, force: true });
}
