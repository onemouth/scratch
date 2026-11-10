import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from './card-store.js';
import { createVault } from './vault.js';
import { createVaultHttp } from './vault-http.js';
import { createApp } from './index.js';
import { openCanvasMemory } from '../shared/canvas-memory.js';

const PASSWORD = 'correct horse battery staple';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message = 'condition', timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
function fakeSpawnFactory() {
  const children = [];
  const spawn = (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, inputs: [], onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn),
      write: value => child.inputs.push(value), resize() {}, kill: () => child.emit('exit', { exitCode: 0, signal: 15 }) });
    children.push(child);
    return child;
  };
  return { spawn, children };
}
function serviceFixture({ requestTimeout = 1000 } = {}) {
  const cards = new CardStore();
  const agents = new Map();
  let clock = 1000;
  const vault = createVault({ cards, getAgent: id => agents.get(id), requestTimeout, now: () => clock });
  return { cards, agents, vault, advance: ms => { clock += ms; }, close: () => { vault.close(); cards.close(); } };
}
async function appFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vault-test-'));
  const stateFile = join(directory, 'canvas.json');
  const cardsFile = join(directory, 'cards.sqlite');
  const fake = fakeSpawnFactory();
  let app = createApp({ port: 0, stateFile, cardsFile, sessionsRoot: join(directory, 'sessions'), spawnAgent: fake.spawn });
  await app.listen();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const response = await fetch(base() + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: raw ? text : (text ? JSON.parse(text) : null) };
  };
  return { directory, stateFile, cardsFile, fake, get app() { return app; }, set app(value) { app = value; }, base, request,
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
const controlHeaders = app => ({ 'X-Vault-Control': app.vaultControlCode });

test('Vault HTTP redacts unexpected internal error messages', async () => {
  const handler = createVaultHttp({ getVault: () => ({ status() { throw new Error('INTERNAL CRYPTO OR DATABASE DETAIL'); } }), isUnavailable: () => false });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/vault/status`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Vault operation failed' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// Covers the cryptographic/store boundary directly so HTTP serialization cannot hide plaintext leaks.
test('Vault setup stores only randomized wrapped/encrypted data; wrong passwords, backoff, tampering and stale unlock fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-crypto-'));
  const file = join(directory, 'cards.sqlite');
  let cards = new CardStore(file);
  let clock = 10_000;
  let vault = createVault({ cards, getAgent: () => null, now: () => clock });
  try {
    await assert.rejects(vault.setup('short'), /at least 8/);
    clock += 1000;
    await vault.setup(PASSWORD);
    const created = vault.create({ key: 'production login', value: 'TOP-SECRET-PLAINTEXT' });
    const config = cards.vaultConfig();
    assert.equal(config.version, 1);
    assert.notEqual(config.wrapped.ciphertext, Buffer.from('TOP-SECRET-PLAINTEXT').toString('base64'));
    assert.equal(JSON.stringify(cards.list()).includes('TOP-SECRET-PLAINTEXT'), false);
    for (const name of await readdir(directory)) {
      const bytes = await readFile(join(directory, name));
      assert.equal(bytes.includes(Buffer.from(PASSWORD)), false, `${name} contains the master password`);
      assert.equal(bytes.includes(Buffer.from('TOP-SECRET-PLAINTEXT')), false, `${name} contains plaintext Vault data`);
    }
    vault.lock();
    await assert.rejects(vault.unlock('definitely wrong'), error => error.code === 'VAULT_AUTH');
    await assert.rejects(vault.unlock(PASSWORD), error => error.code === 'VAULT_BUSY' && error.status === 429);
    clock += 1000;
    await vault.unlock(PASSWORD);
    assert.equal(vault.reveal(created.id).value, 'TOP-SECRET-PLAINTEXT');

    vault.lock();
    const stale = vault.unlock(PASSWORD);
    vault.lock();
    await assert.rejects(stale, error => error.code === 'VAULT_CHANGED');
    clock += 1000;
    await vault.unlock(PASSWORD);
    const envelope = cards.vaultEnvelope(created.id);
    envelope.ciphertext = envelope.ciphertext.replace(/^./, envelope.ciphertext[0] === 'A' ? 'B' : 'A');
    cards.db.prepare('UPDATE vault_entries SET envelope=? WHERE id=?').run(JSON.stringify(envelope), created.id);
    assert.throws(() => vault.reveal(created.id), error => error.code === 'VAULT_AUTH');

    vault.close(); cards.close();
    cards = new CardStore(file);
    vault = createVault({ cards, getAgent: () => null });
    assert.deepEqual(vault.status().configured, true);
    assert.deepEqual(vault.status().locked, true);

    const resetCards = new CardStore();
    const resetVault = createVault({ cards: resetCards, getAgent: () => null });
    try {
      await resetVault.setup(PASSWORD);
      const secondConfig = resetCards.vaultConfig();
      assert.notEqual(secondConfig.salt, config.salt);
      assert.notEqual(secondConfig.wrapped.ciphertext, config.wrapped.ciphertext);
      resetVault.lock();
      const staleReset = resetVault.unlock(PASSWORD);
      resetVault.reset('RESET VAULT');
      await assert.rejects(staleReset, error => error.code === 'VAULT_CHANGED');
      assert.deepEqual({ configured: resetVault.status().configured, locked: resetVault.status().locked }, { configured: false, locked: true });
    } finally { resetVault.close(); resetCards.close(); }

    vault.close(); cards.close();
    const damaged = new DatabaseSync(file);
    damaged.exec('DELETE FROM vault_config'); damaged.close();
    assert.throws(() => new CardStore(file), /Vault configuration is missing/);
    cards = { close() {} };
  } finally { vault.close(); cards.close(); await rm(directory, { recursive: true, force: true }); }
});

test('service approval is process/generation bound with once, concurrent pending, deny, persistent process grant, revoke, timeout and abort', async () => {
  const fixture = serviceFixture({ requestTimeout: 40 });
  const { cards, agents, vault } = fixture;
  try {
    await vault.setup(PASSWORD);
    const entry = vault.create({ key: 'API key', value: 'secret-value' });
    const otherEntry = vault.create({ key: 'Other key', value: 'other-secret' });
    const process = { id: 'agent-a', name: 'Agent A', status: 'running', processGeneration: 'generation-1' };
    agents.set(process.id, process);
    const channel = vault.openProcess(process.id, process.processGeneration);
    assert.throws(() => vault.retrieve('0'.repeat(64), entry.key), error => error.code === 'VAULT_CALLER');

    const first = vault.retrieve(channel.token, entry.key);
    const second = vault.retrieve(channel.token, entry.key);
    let pending = vault.details().requests;
    assert.equal(pending.length, 2);
    vault.decide(pending[0].id, 'once');
    assert.equal(await first, 'secret-value');
    assert.equal(vault.details().requests.length, 1);
    vault.decide(vault.details().requests[0].id, 'deny');
    await assert.rejects(second, error => error.code === 'VAULT_DENIED');

    const granted = vault.retrieve(channel.token, entry.key);
    const coalesced = vault.retrieve(channel.token, entry.key);
    vault.decide(vault.details().requests[0].id, 'process');
    assert.deepEqual(await Promise.all([granted, coalesced]), ['secret-value', 'secret-value']);
    assert.equal(vault.details().requests.length, 0);
    const grant = vault.details().grants[0];
    vault.lock();
    assert.throws(() => vault.retrieve(channel.token, entry.key), error => error.code === 'VAULT_LOCKED');
    fixture.advance(1000);
    await vault.unlock(PASSWORD);
    assert.equal(await vault.retrieve(channel.token, entry.key), 'secret-value');
    const isolated = vault.retrieve(channel.token, otherEntry.key);
    assert.equal(vault.details().requests.length, 1, 'grant is isolated to one key');
    vault.decide(vault.details().requests[0].id, 'deny');
    await assert.rejects(isolated, error => error.code === 'VAULT_DENIED');
    vault.revoke(grant.id);
    const afterRevoke = vault.retrieve(channel.token, entry.key);
    assert.equal(vault.details().requests.length, 1);
    vault.decide(vault.details().requests[0].id, 'deny');
    await assert.rejects(afterRevoke, error => error.code === 'VAULT_DENIED');

    const abort = new AbortController();
    const cancelled = vault.retrieve(channel.token, entry.key, abort.signal);
    abort.abort();
    await assert.rejects(cancelled, error => error.code === 'VAULT_CANCELLED');
    const expired = vault.retrieve(channel.token, entry.key);
    await assert.rejects(expired, error => error.code === 'VAULT_EXPIRED');

    const fenced = vault.retrieve(channel.token, entry.key);
    process.processGeneration = 'generation-2';
    vault.observeProcesses();
    await assert.rejects(fenced, error => error.code === 'VAULT_GENERATION');
    assert.throws(() => vault.retrieve(channel.token, entry.key), error => error.code === 'VAULT_CALLER');
    const replacement = vault.openProcess(process.id, process.processGeneration);
    assert.notEqual(replacement.token, channel.token);
    replacement.close(); channel.close();
    assert.equal(vault.details().requests.length, 0);
    assert.equal(vault.details().grants.length, 0);
  } finally { fixture.close(); }
});

test('rename/delete revoke per-key approvals while value edits retain them and recreated names get fresh identity', async () => {
  const fixture = serviceFixture();
  const { agents, vault } = fixture;
  try {
    await vault.setup(PASSWORD);
    let entry = vault.create({ key: 'ROTATING_KEY', value: 'one' });
    const originalId = entry.id;
    const agent = { id: 'rotation-agent', name: 'Rotation Agent', status: 'running', processGeneration: 'rotation-1' };
    agents.set(agent.id, agent);
    const channel = vault.openProcess(agent.id, agent.processGeneration);

    const pendingRename = vault.retrieve(channel.token, entry.key);
    entry = vault.update(entry.id, { key: 'RENAMED_KEY' });
    await assert.rejects(pendingRename, error => error.code === 'VAULT_KEY_CHANGED');
    assert.throws(() => vault.retrieve(channel.token, 'ROTATING_KEY'), error => error.code === 'VAULT_ENTRY');

    const approved = vault.retrieve(channel.token, entry.key);
    vault.decide(vault.details().requests[0].id, 'process');
    assert.equal(await approved, 'one');
    vault.update(entry.id, { value: 'two' });
    assert.equal(await vault.retrieve(channel.token, entry.key), 'two', 'same-key value edit retains process grant');

    entry = vault.update(entry.id, { key: 'RENAMED_AGAIN' });
    const afterRename = vault.retrieve(channel.token, entry.key);
    assert.equal(vault.details().requests.length, 1, 'rename revokes the old grant');
    vault.decide(vault.details().requests[0].id, 'process');
    assert.equal(await afterRename, 'two');
    vault.revoke(vault.details().grants[0].id);
    const pendingDelete = vault.retrieve(channel.token, entry.key);
    vault.remove(entry.id, true);
    await assert.rejects(pendingDelete, error => error.code === 'VAULT_DELETED');
    assert.equal(vault.details().grants.length, 0);

    const recreated = vault.create({ key: 'RENAMED_AGAIN', value: 'three' });
    assert.notEqual(recreated.id, originalId);
    const fresh = vault.retrieve(channel.token, recreated.key);
    assert.equal(vault.details().requests.length, 1, 'recreated key never inherits deleted entry grant');
    vault.decide(vault.details().requests[0].id, 'deny');
    await assert.rejects(fresh, error => error.code === 'VAULT_DENIED');
    channel.close();
  } finally { fixture.close(); }
});

test('already-granted retrieval is fenced if lock, revoke or process end happens before Promise delivery', async () => {
  const fixture = serviceFixture();
  const { agents, vault } = fixture;
  try {
    await vault.setup(PASSWORD);
    const entry = vault.create({ key: 'race key', value: 'must-not-escape' });
    const agent = { id: 'race-agent', name: 'Race Agent', status: 'running', processGeneration: 'race-1' };
    agents.set(agent.id, agent);
    let channel = vault.openProcess(agent.id, agent.processGeneration);
    const approve = async () => {
      const waiting = vault.retrieve(channel.token, entry.key);
      vault.decide(vault.details().requests[0].id, 'process');
      assert.equal(await waiting, 'must-not-escape');
      return vault.details().grants[0];
    };
    const settled = promise => promise.then(value => ({ value }), error => ({ error }));

    let grant = await approve();
    const locked = settled(vault.retrieve(channel.token, entry.key));
    vault.lock();
    assert.equal((await locked).error?.code, 'VAULT_LOCKED');
    fixture.advance(1000);
    await vault.unlock(PASSWORD);

    grant = vault.details().grants[0];
    const revoked = settled(vault.retrieve(channel.token, entry.key));
    vault.revoke(grant.id);
    assert.equal((await revoked).error?.code, 'VAULT_REVOKED');

    const approvalRevoked = settled(vault.retrieve(channel.token, entry.key));
    vault.decide(vault.details().requests[0].id, 'process');
    grant = vault.details().grants[0];
    vault.revoke(grant.id);
    assert.equal((await approvalRevoked).error?.code, 'VAULT_REVOKED');

    grant = await approve();
    const ended = settled(vault.retrieve(channel.token, entry.key));
    channel.close();
    assert.equal((await ended).error?.code, 'VAULT_GENERATION');
    assert.ok(grant.id);
  } finally { fixture.close(); }
});

test('HTTP Vault API separates human control from spawned process Bearer auth and keeps secrets out of metadata, state, SHM and search', async () => {
  const fixture = await appFixture();
  const { request, fake } = fixture;
  try {
    const publicStatus = await request('/api/vault/status');
    assert.equal(publicStatus.status, 200);
    assert.deepEqual(Object.keys(publicStatus.data).sort(), ['configured', 'epoch', 'instance', 'locked', 'revision']);
    assert.equal((await request('/api/vault/status')).data.instance, publicStatus.data.instance);
    for (const headers of [{}, { 'X-Canvas-Layout': 'human' }, { 'X-Vault-Control': '0'.repeat(64) }]) {
      const denied = await request('/api/vault/control', { headers });
      assert.equal(denied.status, 403);
      assert.equal(denied.data.code, 'VAULT_CONTROL');
    }
    const control = controlHeaders(fixture.app);
    const cardsBeforeSetup = fixture.app.snapshot().cards;
    const setup = await request('/api/vault/setup', { method: 'POST', body: { password: PASSWORD }, headers: control });
    assert.equal(setup.status, 200);
    assert.deepEqual(fixture.app.snapshot().cards, cardsBeforeSetup);
    const created = await request('/api/vault/entries', { method: 'POST', body: { key: 'visible-key-name', value: 'HTTP-RAW-SECRET' }, headers: control });
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(created.data).includes('HTTP-RAW-SECRET'), false);
    const entryId = created.data.id;
    const publicEntries = await request('/api/vault/entries');
    assert.deepEqual(publicEntries.data.entries, [created.data]);

    const listed = await request('/api/cards');
    const state = await request('/api/state');
    for (const value of [listed.data, state.data, fixture.app.snapshot()]) {
      const serialized = JSON.stringify(value);
      assert.equal(serialized.includes('visible-key-name'), false);
      assert.equal(serialized.includes('HTTP-RAW-SECRET'), false);
    }
    assert.equal((await request('/api/cards?q=HTTP-RAW-SECRET')).data.total, 0);
    assert.equal((await request('/api/cards?q=visible-key-name')).data.total, 0);

    const nativeBuilt = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
    if (nativeBuilt) {
      const reader = openCanvasMemory(fixture.app.sharedMemory.name, fixture.app.sharedMemory.epoch);
      try {
        const raw = JSON.stringify(reader.read());
        assert.equal(raw.includes('visible-key-name'), false);
        assert.equal(raw.includes('HTTP-RAW-SECRET'), false);
      } finally { reader.close(); }
    }

    for (const body of [
      { type: 'vault', key: 'spoof', value: 'secret', place: false },
      { type: 'markdown', content: 'safe', value: 'secret', place: false },
    ]) assert.notEqual((await request('/api/cards', { method: 'POST', body })).status, 201);
    assert.equal((await request(`/api/cards/${entryId}`)).status, 404);
    assert.equal((await request(`/api/cards/${entryId}`, { method: 'PATCH', body: { content: 'stolen' } })).status, 404);
    assert.equal((await request(`/api/cards/${entryId}`, { method: 'DELETE', body: { confirm: true } })).status, 404);
    assert.equal((await request('/api/vault/card', { method: 'PATCH', body: { tags: ['changed'] }, headers: control })).status, 404);

    const agent = await request('/api/agents', { method: 'POST', body: { name: 'Vault caller', workdir: process.cwd(), task: 'fixture' } });
    assert.equal(agent.status, 201);
    const token = fake.children[0].options.env.AGENT_CANVAS_VAULT_TOKEN;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(fake.children[0].options.env.AGENT_CANVAS_VAULT_CONTROL, undefined);
    assert.notEqual(token, fixture.app.vaultControlCode);
    const postSpawnMetadata = JSON.stringify([(await request('/api/state')).data, fixture.app.snapshot()]);
    assert.equal(postSpawnMetadata.includes(token), false);
    assert.equal(postSpawnMetadata.includes(fixture.app.vaultControlCode), false);

    for (const headers of [
      { 'X-Vault-Control': fixture.app.vaultControlCode },
      { Authorization: `Bearer ${'1'.repeat(64)}`, 'X-Agent-Id': agent.data.id },
      { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'spoofed-id' },
    ]) {
      if (headers.Authorization === `Bearer ${token}`) continue;
      const denied = await request('/api/vault/retrieve', { method: 'POST', body: { key: created.data.key }, headers });
      assert.equal(denied.status, 403);
      assert.equal(denied.data.code, 'VAULT_CALLER');
    }

    const retrieval = fetch(fixture.base() + '/api/vault/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Agent-Id': 'spoofed-id' }, body: JSON.stringify({ key: created.data.key }) });
    const pending = await waitFor(async () => (await request('/api/vault/control', { headers: control })).data.requests[0], 'pending HTTP Vault request');
    assert.equal(pending.agentId, agent.data.id);
    assert.equal(pending.entryId, entryId);
    assert.equal(await (await request(`/api/vault/requests/${pending.id}/decision`, { method: 'POST', body: { decision: 'once' }, headers: control })).status, 200);
    const response = await retrieval;
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(await response.text(), 'HTTP-RAW-SECRET');

    fake.children[0].emit('exit', { exitCode: 0, signal: null });
    const fenced = await request('/api/vault/retrieve', { method: 'POST', body: { key: created.data.key }, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(fenced.status, 403);
    assert.equal(fenced.data.code, 'VAULT_CALLER');
    assert.equal((await request(`/api/agents/${agent.data.id}/resume`, { method: 'POST', body: {} })).status, 200);
    const replacementToken = fake.children[1].options.env.AGENT_CANVAS_VAULT_TOKEN;
    assert.notEqual(replacementToken, token);
    const replacementRetrieval = fetch(fixture.base() + '/api/vault/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${replacementToken}` }, body: JSON.stringify({ key: created.data.key }) });
    const replacementPending = await waitFor(async () => (await request('/api/vault/control', { headers: control })).data.requests[0], 'replacement process request');
    await request(`/api/vault/requests/${replacementPending.id}/decision`, { method: 'POST', body: { decision: 'deny' }, headers: control });
    assert.equal((await replacementRetrieval).status, 403);
  } finally { await fixture.close(); }
});

test('HTTP disconnect cancels pending retrieval; reset while locked clears all Vault state but preserves ordinary cards, then restart stays locked with no replay', async () => {
  const fixture = await appFixture();
  const { request, fake } = fixture;
  try {
    const control = controlHeaders(fixture.app);
    const ordinary = (await request('/api/cards', { method: 'POST', body: { content: 'keep me', place: true } })).data;
    const libraryBeforeVault = fixture.app.snapshot().cards;
    const placementsBeforeVault = fixture.app.snapshot().cardPlacements;
    const { revision: _viewRevision, ...viewsBeforeVault } = fixture.app.snapshot().cardBox;
    await request('/api/vault/setup', { method: 'POST', body: { password: PASSWORD }, headers: control });
    const secret = (await request('/api/vault/entries', { method: 'POST', body: { key: 'reset-key', value: 'reset-secret' }, headers: control })).data;
    assert.deepEqual(fixture.app.snapshot().cards, libraryBeforeVault);
    assert.deepEqual(fixture.app.snapshot().cardPlacements, placementsBeforeVault);
    { const { revision: _revision, ...currentViews } = fixture.app.snapshot().cardBox; assert.deepEqual(currentViews, viewsBeforeVault); }
    const agent = (await request('/api/agents', { method: 'POST', body: { name: 'Reset caller', workdir: process.cwd() } })).data;
    const token = fake.children[0].options.env.AGENT_CANVAS_VAULT_TOKEN;

    const disconnected = http.request(fixture.base() + '/api/vault/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    disconnected.on('error', () => {});
    disconnected.end(JSON.stringify({ key: secret.key }));
    await waitFor(async () => (await request('/api/vault/control', { headers: control })).data.requests.length === 1, 'disconnect request');
    disconnected.destroy();
    await waitFor(async () => (await request('/api/vault/control', { headers: control })).data.requests.length === 0, 'disconnect cancellation');

    const grantRequest = fetch(fixture.base() + '/api/vault/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ key: secret.key }) });
    const pending = await waitFor(async () => (await request('/api/vault/control', { headers: control })).data.requests[0], 'grant request');
    await request(`/api/vault/requests/${pending.id}/decision`, { method: 'POST', body: { decision: 'process' }, headers: control });
    assert.equal(await (await grantRequest).text(), 'reset-secret');
    assert.equal((await request('/api/vault/control', { headers: control })).data.grants.length, 1);
    await request('/api/vault/lock', { method: 'POST', body: {}, headers: control });
    const reset = await request('/api/vault/reset', { method: 'POST', body: { confirmation: 'RESET VAULT' }, headers: control });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.configured, false);
    assert.equal(reset.data.locked, true);
    assert.equal((await request('/api/vault/control', { headers: control })).data.grants.length, 0);
    assert.deepEqual(fixture.app.snapshot().cards, libraryBeforeVault);
    assert.deepEqual(fixture.app.snapshot().cardPlacements, placementsBeforeVault);
    { const { revision: _revision, ...currentViews } = fixture.app.snapshot().cardBox; assert.deepEqual(currentViews, viewsBeforeVault); }
    assert.equal(fixture.app.snapshot().cards.some(card => card.id === ordinary.id), true);
    assert.deepEqual((await request('/api/vault/entries')).data.entries, []);

    await fixture.app.close();
    fixture.app = createApp({ port: 0, stateFile: fixture.stateFile, cardsFile: fixture.cardsFile, sessionsRoot: join(fixture.directory, 'sessions'), spawnAgent: fake.spawn });
    await fixture.app.listen();
    const beforeRestartInstance = reset.data.instance;
    const restarted = await request('/api/vault/status');
    assert.deepEqual({ configured: restarted.data.configured, locked: restarted.data.locked }, { configured: false, locked: true });
    assert.notEqual(restarted.data.instance, beforeRestartInstance);
    assert.equal(fixture.app.snapshot().cards.some(card => card.id === ordinary.id), true);
    const newControl = controlHeaders(fixture.app);
    const details = await request('/api/vault/control', { headers: newControl });
    assert.deepEqual(details.data.requests, []);
    assert.deepEqual(details.data.grants, []);
    assert.equal(fake.children.at(-1).options.env.AGENT_CANVAS_VAULT_TOKEN === token, false);
    assert.equal(agent.id, fixture.app.snapshot().agents[0].id);
  } finally { await fixture.close(); }
});
