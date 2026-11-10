import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createApp } from '../../server/index.js';

const dir = await mkdtemp(join(tmpdir(), 'canvas-vault-pi-'));
const events = [], bus = new EventEmitter(), peers = [];
const secret = 'vault-disposable-secret-中文-🧋';
let app, failure;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function waitFor(predicate, after = 0) {
  const match = events.slice(after).find(predicate);
  if (match) return Promise.resolve(match);
  return new Promise((resolve, reject) => {
    const done = (error, value) => { clearTimeout(timer); bus.off('event', check); error ? reject(error) : resolve(value); };
    const check = event => { if (failure) done(failure); else if (predicate(event)) done(null, event); };
    const timer = setTimeout(() => done(new Error('Vault Pi diagnostic timed out')), 20000);
    bus.on('event', check);
  });
}
const notify = (prefix, after) => waitFor(event => event.type === 'extension_ui_request' && event.message?.startsWith(prefix), after);
function command(message) { peers.at(-1).child.stdin.write(JSON.stringify({ id: String(events.length), type: 'prompt', message }) + '\n'); }
try {
  app = createApp({ port: 0, spawnAgent(_bin, args, options) {
    const wrapper = new EventEmitter();
    const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', ...args,
      '--extension', fileURLToPath(new URL('./pi-vault-extension.js', import.meta.url))], {
      cwd: dir, env: { ...options.env, PI_CODING_AGENT_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = { child, exit: once(child, 'exit') }; peer.exit.catch(() => {}); peers.push(peer);
    child.stdout.on('data', data => wrapper.emit('data', data.toString()));
    child.on('exit', (exitCode, signal) => wrapper.emit('exit', { exitCode, signal }));
    child.on('error', error => { failure = error; bus.emit('event', {}); });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'agent_start' || event.type === 'extension_error' || (event.type === 'response' && event.success === false)) failure = new Error('Unexpected model turn or Pi error in Vault diagnostic');
        events.push(event); bus.emit('event', event);
      } catch { failure = new Error('Invalid Pi RPC output'); bus.emit('event', {}); }
    });
    // stderr is deliberately not printed: subprocess diagnostics must not leak credentials.
    child.stderr.resume();
    return Object.assign(wrapper, { onData: fn => wrapper.on('data', fn), onExit: fn => wrapper.on('exit', fn),
      write: value => child.stdin.write(value), resize() {}, kill: signal => child.kill(signal ?? 'SIGTERM') });
  } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, method = 'GET', body, human = false) {
    const response = await fetch(base + '/api' + path, { method,
      headers: { 'Content-Type': 'application/json', ...(human ? { 'X-Vault-Control': app.vaultControlCode } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  await api('/vault/setup', 'POST', { password: 'disposable fixture password' }, true);
  const entry = await api('/vault/entries', 'POST', { key: 'FIXTURE_TOKEN', value: secret }, true);
  await api('/vault/entries', 'POST', { key: 'OTHER_TOKEN', value: 'separate-key-secret' }, true);
  assert.deepEqual(app.snapshot().cards, [], 'Vault never creates a library card');
  assert.equal((await api('/vault/entries')).entries.length, 2);
  const agent = await api('/agents', 'POST', { name: 'Vault fixture Pi', workdir: dir });
  await notify('VAULT_READY:');
  const digest = createHash('sha256').update(secret).digest('hex');
  async function retrieval({ approval = null, expected = 0, key = entry.key } = {}) {
    const after = events.length; command('/vault-smoke ' + JSON.stringify({ key }));
    if (approval) {
      let pending;
      for (let i = 0; i < 100; i++) {
        pending = (await api('/vault/control', 'GET', undefined, true)).requests[0];
        if (pending) break; await delay(25);
      }
      assert.ok(pending, 'Pi shell request reached human approval');
      await api('/vault/requests/' + pending.id + '/decision', 'POST', { decision: approval }, true);
    }
    const result = JSON.parse((await notify('VAULT_RESULT:', after)).message.slice('VAULT_RESULT:'.length));
    assert.equal(result.code, expected); assert.equal(result.digest, expected === 0 ? digest : null);
  }
  await retrieval({ approval: 'once' });
  assert.equal((await api('/vault/control', 'GET', undefined, true)).grants.length, 0);
  await retrieval({ approval: 'process' });
  await retrieval({ key: 'OTHER_TOKEN', approval: 'deny', expected: 22 });
  assert.equal((await api('/vault/control', 'GET', undefined, true)).grants.length, 1);
  const generation = app.runtime.get(agent.id).processGeneration;
  let after = events.length; command('/vault-reload'); await notify('VAULT_READY:reload', after);
  await retrieval();
  after = events.length; peers.at(-1).child.stdin.write(JSON.stringify({ id: 'new', type: 'new_session' }) + '\n'); await notify('VAULT_READY:new', after);
  await retrieval(); assert.equal(app.runtime.get(agent.id).processGeneration, generation);
  await api('/vault/lock', 'POST', {}, true); await retrieval({ expected: 22 });
  await api('/vault/unlock', 'POST', { password: 'disposable fixture password' }, true); await retrieval();
  const oldExit = peers.at(-1).exit;
  await api('/agents/' + agent.id + '/stop', 'POST', {}); await oldExit;
  assert.equal((await api('/vault/control', 'GET', undefined, true)).grants.length, 0);
  after = events.length;
  await api('/agents/' + agent.id + '/resume', 'POST', {}); await notify('VAULT_READY:', after);
  assert.notEqual(app.runtime.get(agent.id).processGeneration, generation);
  await retrieval({ approval: 'deny', expected: 22 });
  await retrieval({ approval: 'once' });
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(app.snapshot().agents.some(agent => agent.output.includes(secret)), false);
  if (failure) throw failure;
  console.log('Real Pi controlled its own curl/shell: management-only Vault/no cards, multiple keys, per-key once/process/deny, reload/new grant retention, lock/unlock, exit/relaunch fencing and digest-only results passed. No LLM or external network calls.');
} finally {
  await app?.close();
  for (const peer of peers) if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill('SIGKILL');
  await Promise.allSettled(peers.map(peer => peer.exit));
  await rm(dir, { recursive: true, force: true });
}
