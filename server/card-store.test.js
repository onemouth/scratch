import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from './card-store.js';

test('SQLite cards survive restart, keep daily sequences and create a usable backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'card-store-'));
  const file = join(dir, 'cards.sqlite');
  let now = new Date(2026, 9, 3, 12);
  let store = new CardStore(file, () => now);
  try {
    const first = store.create({ content: '**中文** hello', tags: [' tag ', 'tag'] });
    assert.equal(first.id, '2026-10-03-0001');
    assert.deepEqual(first.tags, ['tag']);
    assert.equal(first.units, 3);
    assert.throws(() => store.update(first.id, { content: '中'.repeat(601), tags: ['changed'] }));
    assert.equal(store.get(first.id).content, first.content);
    store.delete(first.id);
    assert.equal(store.create().id, '2026-10-03-0002');
    now = new Date(2026, 9, 4, 12);
    assert.equal(store.create().id, '2026-10-04-0001');
    await store.backup();
    store.close();
    store = new CardStore(file, () => now);
    assert.equal(store.list().length, 2);
    assert.equal(store.create().id, '2026-10-04-0002');
    const backup = new CardStore(file + '.bak');
    assert.equal(backup.list().length, 2);
    backup.close();
    assert.throws(() => store.create({ tags: ['x,y'] }), /tags/);
    assert.throws(() => store.get('missing'), /not found/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
