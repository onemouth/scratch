import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from './card-store.js';
import { createVault } from './vault.js';
import { newVault, seal, valueAAD } from './vault-crypto.js';
import { canvasMemoryProjection } from './canvas-memory.js';
import { searchCards } from '../shared/card-search.js';

const password = 'isolated boundary fixture password';
const envelope = (key, id, name, value) => JSON.stringify(seal(key, Buffer.from(value), valueAAD(id, name)));

async function schema6Fixture({ duplicate = false, missing = false, noConfig = false, nonCanonical = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vault-v6-')), file = join(directory, 'cards.sqlite');
  let store = new CardStore(file, () => new Date(2026, 9, 3, 12));
  const ordinaryA = store.create({ content: 'ordinary A' }), ordinaryB = store.create({ content: 'ordinary B', links: [ordinaryA.id] });
  store.close();
  const { key, config } = await newVault(password);
  const firstId = '2026-10-03-0003', secondId = '2026-10-03-0004';
  const firstKey = nonCanonical ? ' TOKEN_A ' : 'TOKEN_A', secondKey = duplicate ? firstKey : 'TOKEN_B';
  const db = new DatabaseSync(file);
  db.exec(`DROP INDEX IF EXISTS cards_single_vault; DROP TABLE vault_entries;
    CREATE TABLE card_vault_values (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
    DELETE FROM vault_config; PRAGMA user_version=6;`);
  const timestamp = '2026-10-03T12:00:00.000Z';
  if (!noConfig) db.prepare('INSERT INTO vault_config (id,config) VALUES (1,?)').run(JSON.stringify(config));
  const insertCard = db.prepare('INSERT INTO cards (id,content,tags,created_at,updated_at,links,type,title,interactive_html,interactive_css,interactive_javascript) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insertCard.run(firstId, '', '["obsolete"]', timestamp, timestamp, JSON.stringify([ordinaryA.id]), 'vault', firstKey, '', '', '');
  insertCard.run(secondId, '', '["obsolete2"]', timestamp, timestamp, JSON.stringify([ordinaryB.id]), 'vault', secondKey, '', '', '');
  db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify([ordinaryB.id, firstId, secondId]), ordinaryA.id);
  db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify([ordinaryA.id, secondId]), ordinaryB.id);
  db.prepare('INSERT INTO card_vault_values (card_id,envelope) VALUES (?,?)').run(firstId, envelope(key, firstId, firstKey, 'secret A'));
  if (!missing) db.prepare('INSERT INTO card_vault_values (card_id,envelope) VALUES (?,?)').run(secondId, envelope(key, secondId, secondKey, 'secret B'));
  db.prepare("UPDATE card_sequences SET number=4 WHERE day='2026-10-03'").run();
  db.close(); key.fill(0);
  return { directory, file, ordinaryA, ordinaryB, firstId, secondId };
}

test('global Vault setup and entry writes never create or mutate cards, sequences, search or SHM metadata', async () => {
  const cards = new CardStore(), vault = createVault({ cards, getAgent: () => null });
  try {
    const ordinary = cards.create({ content: 'ordinary content', tags: ['keep'] });
    const cardsBefore = cards.list(), sequenceBefore = cards.db.prepare('SELECT * FROM card_sequences').all();
    await vault.setup(password);
    assert.deepEqual(cards.list(), cardsBefore);
    assert.deepEqual(cards.db.prepare('SELECT * FROM card_sequences').all(), sequenceBefore);
    assert.throws(() => cards.create({ type: 'vault' }), /markdown or interactive/);

    const first = vault.create({ key: ' TOKEN_A ', value: 'same secret' });
    const second = vault.create({ key: 'TOKEN_B', value: 'same secret' });
    assert.equal(first.key, 'TOKEN_A'); assert.notEqual(first.id, second.id);
    assert.notDeepEqual(cards.vaultEnvelope(first.id), cards.vaultEnvelope(second.id));
    assert.throws(() => vault.create({ key: 'TOKEN_A', value: 'other' }), error => error.code === 'VAULT_KEY_EXISTS');
    assert.equal(vault.create({ key: 'token_a', value: 'case-sensitive' }).key, 'token_a');

    const originalEnvelope = cards.vaultEnvelope(first.id);
    cards.db.prepare('UPDATE vault_entries SET envelope=? WHERE id=?').run(JSON.stringify(cards.vaultEnvelope(second.id)), first.id);
    assert.throws(() => vault.reveal(first.id), error => error.code === 'VAULT_AUTH');
    cards.db.prepare('UPDATE vault_entries SET envelope=? WHERE id=?').run(JSON.stringify(originalEnvelope), first.id);
    assert.equal(vault.update(first.id, { key: 'RENAMED_TOKEN' }).key, 'RENAMED_TOKEN');
    assert.equal(vault.reveal(first.id).value, 'same secret');
    assert.throws(() => vault.update(first.id, { key: 'TOKEN_B' }), error => error.code === 'VAULT_KEY_EXISTS');

    assert.deepEqual(cards.list(), cardsBefore);
    assert.deepEqual(cards.db.prepare('SELECT * FROM card_sequences').all(), sequenceBefore);
    assert.deepEqual(searchCards(cards.list(), 'RENAMED_TOKEN'), []);
    const projection = canvasMemoryProjection({ agents: [], edges: [], notes: [], cards: cards.list(), cardPlacements: [] });
    assert.equal(JSON.stringify(projection).includes('RENAMED_TOKEN'), false);
    assert.equal(JSON.stringify(projection).includes('same secret'), false);
    assert.deepEqual(cards.get(ordinary.id), cardsBefore[0]);

    assert.deepEqual(cards.resetVault(), []);
    assert.equal(cards.vaultConfig(), null); assert.deepEqual(cards.vaultEntries(), []);
    assert.deepEqual(cards.list(), cardsBefore);
    assert.deepEqual(cards.db.prepare('SELECT * FROM card_sequences').all(), sequenceBefore);
  } finally { vault.close(); cards.close(); }
});

test('schema6 migration preserves entry IDs/ciphertext/AAD, removes all Vault cards and only strips their reverse links', async () => {
  const fixture = await schema6Fixture();
  let store;
  try {
    store = new CardStore(fixture.file, () => new Date(2026, 9, 3, 12));
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(store.list().some(card => card.type === 'vault'), false);
    assert.deepEqual(store.get(fixture.ordinaryA.id).links, [fixture.ordinaryB.id]);
    assert.deepEqual(store.get(fixture.ordinaryB.id).links, [fixture.ordinaryA.id]);
    assert.deepEqual(store.vaultEntries().map(entry => entry.id), [fixture.firstId, fixture.secondId]);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='card_vault_values'").get(), undefined);
    assert.equal(store.create().id, '2026-10-03-0005');
    const vault = createVault({ cards: store, getAgent: () => null });
    try {
      await vault.unlock(password);
      assert.equal(vault.reveal(fixture.firstId).value, 'secret A');
      assert.equal(vault.reveal(fixture.secondId).value, 'secret B');
    } finally { vault.close(); }
  } finally { store?.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('configured schema6 without keys migrates without creating a card or consuming a card sequence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-v6-empty-')), file = join(directory, 'cards.sqlite');
  let store = new CardStore(file, () => new Date(2026, 9, 3, 12)); store.close();
  const { key, config } = await newVault(password); key.fill(0);
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE vault_entries; CREATE TABLE card_vault_values (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
    DELETE FROM vault_config; PRAGMA user_version=6;`);
  db.prepare('INSERT INTO vault_config (id,config) VALUES (1,?)').run(JSON.stringify(config)); db.close();
  try {
    store = new CardStore(file, () => new Date(2026, 9, 3, 12));
    assert.equal(store.list().length, 0); assert.deepEqual(store.vaultEntries(), []);
    assert.equal(store.create().id, '2026-10-03-0001');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema6 duplicate keys, missing ciphertext, missing config or noncanonical AAD key fail and roll back', async () => {
  for (const options of [{ duplicate: true }, { missing: true }, { noConfig: true }, { nonCanonical: true }]) {
    const fixture = await schema6Fixture(options);
    try {
      assert.throws(() => new CardStore(fixture.file), /already exists|missing|canonical/);
      const db = new DatabaseSync(fixture.file);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='card_vault_values'").get());
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cards WHERE type='vault'").get().count, 2);
      } finally { db.close(); }
    } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});

test('schema7 migration removes the singleton card and reverse links without changing config, entries, ciphertext or timestamps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-v7-')), file = join(directory, 'cards.sqlite');
  let store = new CardStore(file, () => new Date(2026, 9, 3, 12));
  const ordinary = store.create({ content: 'preserve me', tags: ['ordinary'] }); store.close();
  const { key, config } = await newVault(password), entryId = '11111111-2222-4333-8444-555555555555', timestamp = '2026-10-03T12:34:56.000Z';
  const savedEnvelope = envelope(key, entryId, 'V7_KEY', 'v7 secret'); key.fill(0);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=7; CREATE UNIQUE INDEX cards_single_vault ON cards(type) WHERE type=\'vault\';');
  db.prepare('INSERT INTO vault_config (id,config) VALUES (1,?)').run(JSON.stringify(config));
  db.prepare('INSERT INTO vault_entries (id,key,envelope,created_at,updated_at) VALUES (?,?,?,?,?)').run(entryId, 'V7_KEY', savedEnvelope, timestamp, timestamp);
  const rootId = '2026-10-03-0002';
  db.prepare('INSERT INTO cards (id,content,tags,created_at,updated_at,links,type,title,interactive_html,interactive_css,interactive_javascript) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(rootId, '', '["obsolete"]', timestamp, timestamp, JSON.stringify([ordinary.id]), 'vault', 'Vault', '', '', '');
  db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify([rootId]), ordinary.id); db.close();
  try {
    store = new CardStore(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(store.list().some(card => card.type === 'vault'), false);
    assert.deepEqual(store.get(ordinary.id).links, []);
    assert.equal(JSON.stringify(store.vaultConfig()), JSON.stringify(config));
    assert.deepEqual(store.vaultEntry(entryId), { id: entryId, key: 'V7_KEY', createdAt: timestamp, updatedAt: timestamp });
    assert.equal(JSON.stringify(store.vaultEnvelope(entryId)), savedEnvelope);
    const vault = createVault({ cards: store, getAgent: () => null });
    try { await vault.unlock(password); assert.equal(vault.reveal(entryId).value, 'v7 secret'); } finally { vault.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema6 migration keeps more than 256 legacy entries readable while service blocks only new additions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-v6-large-')), file = join(directory, 'cards.sqlite');
  let store = new CardStore(file); store.close();
  const { key, config } = await newVault(password), db = new DatabaseSync(file), timestamp = '2026-10-03T12:00:00.000Z';
  db.exec(`DROP TABLE vault_entries; CREATE TABLE card_vault_values (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
    DELETE FROM vault_config; PRAGMA user_version=6; BEGIN IMMEDIATE;`);
  db.prepare('INSERT INTO vault_config (id,config) VALUES (1,?)').run(JSON.stringify(config));
  const insertCard = db.prepare('INSERT INTO cards (id,content,tags,created_at,updated_at,links,type,title,interactive_html,interactive_css,interactive_javascript) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insertValue = db.prepare('INSERT INTO card_vault_values (card_id,envelope) VALUES (?,?)');
  for (let i = 1; i <= 257; i++) {
    const id = `2026-10-03-${String(i).padStart(4, '0')}`, name = `LEGACY_${String(i).padStart(3, '0')}`;
    insertCard.run(id, '', '[]', timestamp, timestamp, '[]', 'vault', name, '', '', '');
    insertValue.run(id, envelope(key, id, name, `secret-${i}`));
  }
  db.exec('COMMIT'); db.close(); key.fill(0);
  try {
    store = new CardStore(file); assert.equal(store.vaultEntries().length, 257); assert.equal(store.list().length, 0);
    const vault = createVault({ cards: store, getAgent: () => null });
    try {
      await vault.unlock(password);
      assert.throws(() => vault.create({ key: 'TOO_MANY', value: 'blocked' }), error => error.code === 'VAULT_CAPACITY');
      assert.equal(vault.entries().length, 257);
    } finally { vault.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Vault startup fails closed when crypto configuration is missing or unsupported', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vault-corruption-')), file = join(directory, 'cards.sqlite');
  let cards = new CardStore(file), vault = createVault({ cards, getAgent: () => null });
  try {
    await vault.setup(password); vault.create({ key: 'TOKEN', value: 'fixture' });
    cards.db.prepare("UPDATE vault_config SET config='{}'").run(); vault.close(); cards.close(); cards = null;
    assert.throws(() => new CardStore(file), /authentication failed/);
    const db = new DatabaseSync(file); db.exec('DELETE FROM vault_config'); db.close();
    assert.throws(() => new CardStore(file), /configuration is missing/);
  } finally { vault.close(); cards?.close(); rmSync(directory, { recursive: true, force: true }); }
});
