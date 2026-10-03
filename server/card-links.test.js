import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from './card-store.js';

test('links reference other cards, deduplicate, reject self/missing IDs atomically, retain deleted references', () => {
  const store = new CardStore();
  try {
    const target = store.create({ content: 'Target' });
    const source = store.create({ content: 'Source', links: [target.id, target.id] });
    assert.deepEqual(source.links, [target.id]);
    assert.throws(() => store.update(source.id, { content: 'changed', links: [source.id] }), /itself/);
    assert.throws(() => store.update(source.id, { links: ['2026-10-03-9999'] }), /not found/);
    assert.throws(() => store.update(source.id, { links: ['bad'] }), /format/);
    assert.equal(store.get(source.id).content, 'Source');
    store.delete(target.id);
    assert.deepEqual(store.update(source.id, { tags: ['updated'], links: [target.id] }).links, [target.id]);
    assert.deepEqual(store.update(source.id, { links: [] }).links, []);
    assert.throws(() => store.update(source.id, { links: [target.id] }), /not found/);
  } finally { store.close(); }
});

test('SQLite v1 migration keeps existing content, tags, ID and daily sequence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-links-migrate-'));
  const file = join(directory, 'cards.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE cards (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE card_sequences (day TEXT PRIMARY KEY, number INTEGER NOT NULL);
    INSERT INTO cards VALUES ('2026-10-03-0001','Original','["tag"]','2026-10-03T12:00:00Z','2026-10-03T12:00:00Z');
    INSERT INTO card_sequences VALUES ('2026-10-03',1);
    PRAGMA user_version=1;
  `);
  legacy.close();
  const store = new CardStore(file, () => new Date(2026, 9, 3, 12));
  try {
    const card = store.get('2026-10-03-0001');
    assert.equal(card.content, 'Original');
    assert.deepEqual(card.tags, ['tag']);
    assert.deepEqual(card.links, []);
    const next = store.create({ links: [card.id] });
    assert.equal(next.id, '2026-10-03-0002');
    assert.deepEqual(next.links, [card.id]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
