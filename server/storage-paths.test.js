import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storagePaths } from './storage-paths.js';
import { lockCanvas } from './canvas-store.js';
import { CardStore } from './card-store.js';

test('default storage migrates stopped legacy data, retaining originals and excluding locks', () => {
  const home = mkdtempSync(join(tmpdir(), 'canvas-paths-'));
  const legacy = join(home, '.agent-canvas');
  mkdirSync(legacy);
  const state = '{"version":1,"agents":[],"notes":[],"edges":[]}';
  writeFileSync(join(legacy, 'canvas.json'), state);
  const store = new CardStore(join(legacy, 'cards.sqlite'));
  const card = store.create({ content: 'Keep this' });
  store.close();
  try {
    mkdirSync(join(home, 'Documents', 'agent-canvas'), { recursive: true }); // Existing empty destination also works.
    const paths = storagePaths({ home, env: {} });
    assert.equal(paths.migrated, true);
    assert.equal(paths.stateFile, join(home, 'Documents', 'agent-canvas', 'canvas.json'));
    assert.equal(readFileSync(paths.stateFile, 'utf8'), state);
    assert.equal(readFileSync(join(legacy, 'canvas.json'), 'utf8'), state);
    assert.equal(existsSync(paths.stateFile + '.lock'), false);
    assert.equal(existsSync(paths.cardsFile + '.lock'), false);
    const moved = new CardStore(paths.cardsFile);
    assert.equal(moved.get(card.id).content, 'Keep this');
    moved.close();
    writeFileSync(paths.stateFile, 'newer data');
    assert.equal(storagePaths({ home, env: {} }).migrated, false);
    assert.equal(readFileSync(paths.stateFile, 'utf8'), 'newer data');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('active legacy server blocks migration; explicit overrides skip migration', () => {
  const home = mkdtempSync(join(tmpdir(), 'canvas-paths-'));
  const legacy = join(home, '.agent-canvas');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'canvas.json'), '{}');
  const unlock = lockCanvas(join(legacy, 'canvas.json'));
  try {
    assert.throws(() => storagePaths({ home, env: {} }), /already open/);
    assert.equal(existsSync(join(home, 'Documents', 'agent-canvas')), false);
    const paths = storagePaths({ home, env: { AGENT_CANVAS_STATE_FILE: join(home, 'custom.json'), AGENT_CANVAS_CARDS_FILE: join(home, 'custom.sqlite') } });
    assert.equal(paths.migrated, false);
    assert.equal(paths.stateFile, join(home, 'custom.json'));
  } finally { unlock(); rmSync(home, { recursive: true, force: true }); }
});
