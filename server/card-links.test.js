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
    assert.deepEqual(store.get(target.id).links, [source.id]);
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
    assert.deepEqual(store.get(card.id).links, [next.id]);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('adding and removing links from either end synchronizes both cards atomically', () => {
  const store = new CardStore();
  try {
    const a = store.create(), b = store.create(), c = store.create();
    store.update(a.id, { links: [b.id, c.id] });
    assert.deepEqual(store.get(b.id).links, [a.id]);
    assert.deepEqual(store.get(c.id).links, [a.id]);
    store.update(b.id, { links: [] });
    assert.deepEqual(store.get(a.id).links, [c.id]);
    assert.deepEqual(store.get(b.id).links, []);
    store.update(c.id, { links: [a.id, b.id] });
    assert.deepEqual(store.get(b.id).links, [c.id]);
    store.update(c.id, { links: [] });
    assert.deepEqual(store.get(a.id).links, []);
    assert.deepEqual(store.get(b.id).links, []);
    const full = store.create();
    for (let i = 0; i < 100; i++) store.create({ links: [full.id] });
    assert.equal(store.get(full.id).links.length, 100);
    const before = store.list();
    assert.throws(() => store.update(a.id, { content: 'Do not save', links: [b.id, full.id] }), /exceed 100/);
    assert.deepEqual(store.list(), before);
    assert.throws(() => store.create({ links: [full.id] }), /exceed 100/);
    assert.deepEqual(store.list(), before);
    // Failed creation rolls back its daily ID allocation too.
    const latest = store.list()[0].id;
    assert.equal(Number(store.create().id.slice(11)), Number(latest.slice(11)) + 1);
  } finally { store.close(); }
});

test('SQLite v2 migration fills missing reverse links once, preserving deleted references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-links-v2-'));
  const file = join(directory, 'cards.sqlite');
  let store = new CardStore(file);
  const a = store.create({ content: 'Original A', tags: ['tag'] }), b = store.create({ content: 'Original B' });
  const missing = '2000-01-01-0001';
  store.db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify([b.id, missing]), a.id);
  store.db.exec('PRAGMA user_version=2');
  store.close();
  try {
    store = new CardStore(file);
    assert.deepEqual(store.get(a.id).links, [b.id, missing]);
    assert.deepEqual(store.get(b.id).links, [a.id]);
    assert.equal(store.get(a.id).content, 'Original A');
    assert.deepEqual(store.get(a.id).tags, ['tag']);
    assert.equal(store.get(a.id).createdAt, a.createdAt);
    const snapshot = store.list();
    store.close();
    store = new CardStore(file);
    assert.deepEqual(store.list(), snapshot); // No repeated migration or timestamp changes.
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
