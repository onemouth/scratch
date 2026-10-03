import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from './card-store.js';

test('backfill rolls back every reverse link and schema version if a target is full', () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-link-backfill-'));
  const file = join(directory, 'cards.sqlite');
  const store = new CardStore(file);
  const source = store.create(), target = store.create(), full = store.create();
  const historical = Array.from({ length: 100 }, (_, i) => '2000-01-01-' + String(i + 1).padStart(4, '0'));
  store.db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify([target.id, full.id]), source.id);
  store.db.prepare('UPDATE cards SET links=? WHERE id=?').run(JSON.stringify(historical), full.id);
  store.db.exec('PRAGMA user_version=2');
  const before = store.db.prepare('SELECT * FROM cards ORDER BY id').all();
  store.close();
  let raw;
  try {
    assert.throws(() => new CardStore(file), /exceed 100/);
    raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual(raw.prepare('SELECT * FROM cards ORDER BY id').all(), before);
  } finally { raw?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reciprocal edits update target timestamps without changing content, tags or creation time', () => {
  let now = new Date('2026-10-03T12:00:00Z');
  const store = new CardStore(':memory:', () => now);
  try {
    const source = store.create(), target = store.create({ content: 'Keep this', tags: ['tag'] });
    now = new Date('2026-10-03T13:00:00Z');
    store.update(source.id, { links: [target.id] });
    const linked = store.get(target.id);
    assert.equal(linked.updatedAt, now.toISOString());
    assert.equal(linked.content, target.content);
    assert.deepEqual(linked.tags, target.tags);
    assert.equal(linked.createdAt, target.createdAt);
    now = new Date('2026-10-03T14:00:00Z');
    store.update(source.id, { links: [] });
    assert.equal(store.get(target.id).updatedAt, now.toISOString());
    assert.deepEqual(store.get(target.id).links, []);
    store.delete(target.id);
  } finally { store.close(); }
});
