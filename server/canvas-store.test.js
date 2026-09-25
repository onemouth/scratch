import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCanvas, lockCanvas, saveCanvas } from './canvas-store.js';

const empty = { agents: [], notes: [], edges: [] };
test('atomic save keeps previous backup and refuses corrupt or future schemas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-store-'));
  const file = join(dir, 'canvas.json');
  try {
    assert.equal(loadCanvas(file), null);
    saveCanvas(file, empty);
    saveCanvas(file, { ...empty, notes: [{ id: 'n', title: 'Plan', text: 'Review', x: 0, y: 0, width: 200, height: 200 }] });
    assert.equal(loadCanvas(file).notes.length, 1);
    assert.equal(loadCanvas(file + '.bak').notes.length, 0);
    await writeFile(file, '{bad');
    assert.throws(() => saveCanvas(file, empty));
    assert.equal(await readFile(file, 'utf8'), '{bad');
    assert.equal(loadCanvas(file + '.bak').notes.length, 0);
    await writeFile(file, JSON.stringify({ version: 99, ...empty }));
    assert.throws(() => loadCanvas(file), /unsupported/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a second server cannot own the same Canvas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-lock-'));
  const file = join(dir, 'canvas.json');
  try {
    const unlock = lockCanvas(file);
    assert.throws(() => lockCanvas(file), /already open/);
    unlock();
    const unlockAgain = lockCanvas(file);
    unlock(); // An old owner cannot release a new owner's lock.
    assert.throws(() => lockCanvas(file), /already open/);
    unlockAgain();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
