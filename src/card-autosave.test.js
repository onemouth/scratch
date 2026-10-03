import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardDraft, createCardAutosaver } from './card-autosave.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('debounces drafts, blocks invalid content, and retries failed writes', async () => {
  const writes = [], states = [];
  let fail = false;
  const saver = createCardAutosaver({ initial: { content: '', tags: [] }, delay: 5,
    save: async draft => { if (fail) throw new Error('offline'); writes.push(draft); },
    onStatus: status => states.push(status) });
  try {
    saver.update('first', '');
    saver.update('latest', 'tag, tag');
    await sleep(30);
    assert.deepEqual(writes, [{ content: 'latest', tags: ['tag'], links: [] }]);
    assert.equal(states.at(-1).state, 'saved');
    saver.update('中'.repeat(601), '');
    await sleep(20);
    assert.equal(writes.length, 1);
    assert.equal(states.at(-1).state, 'error');
    assert.equal(saver.isDirty(), true);
    fail = true;
    saver.update('valid', '');
    await sleep(20);
    assert.equal(states.at(-1).error, 'offline');
    fail = false;
    saver.update('valid', '');
    await sleep(20);
    assert.equal(states.at(-1).state, 'saved');
  } finally { saver.dispose(); }
});

test('serializes in-flight writes and preserves the newest draft', async () => {
  const writes = [];
  let finish;
  const saver = createCardAutosaver({ initial: { content: '', tags: [] }, delay: 5,
    save: draft => { writes.push(draft); return new Promise(resolve => { finish = resolve; }); },
    onStatus: () => {} });
  try {
    saver.update('older', '');
    await sleep(20);
    saver.update('newer', '');
    await sleep(20);
    assert.equal(writes.length, 1);
    assert.equal(saver.isDirty(), true);
    finish();
    await sleep(20);
    assert.deepEqual(writes.map(d => d.content), ['older', 'newer']);
    finish();
    await sleep(10);
    assert.equal(saver.isDirty(), false);
  } finally { saver.dispose(); }
});

test('links parse comma/whitespace-separated IDs and reject invalid formats', () => {
  assert.deepEqual(cardDraft('', '', '2026-10-03-0001, 2026-10-03-0002\n2026-10-03-0001').links, ['2026-10-03-0001', '2026-10-03-0002']);
  assert.throws(() => cardDraft('', '', 'not-an-id'), /Links/);
});

test('disposal cancels pending debounce', async () => {
  let writes = 0;
  const saver = createCardAutosaver({ initial: { content: '', tags: [] }, delay: 5, save: async () => writes++, onStatus: () => {} });
  saver.update('draft', '');
  saver.dispose();
  await sleep(20);
  assert.equal(writes, 0);
});
