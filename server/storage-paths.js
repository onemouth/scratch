import { existsSync, mkdirSync, readdirSync, cpSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lockCanvas } from './canvas-store.js';

// Called only by CLI startup, before opening either store. Retain the original
// directory as a recovery copy; never copy a database owned by a live server.
export function storagePaths({ home = homedir(), env = process.env } = {}) {
  const directory = join(home, 'Documents', 'agent-canvas');
  const legacy = join(home, '.agent-canvas');
  let migrated = false;
  if (!env.AGENT_CANVAS_STATE_FILE && !env.AGENT_CANVAS_CARDS_FILE &&
      existsSync(legacy) && ['canvas.json', 'cards.sqlite'].some(name => existsSync(join(legacy, name))) &&
      (!existsSync(directory) || readdirSync(directory).length === 0)) {
    mkdirSync(join(home, 'Documents'), { recursive: true });
    const temporary = directory + '.migrate-' + randomUUID();
    let unlockCanvas = () => {}, unlockCards = () => {};
    try {
      unlockCanvas = lockCanvas(join(legacy, 'canvas.json'));
      unlockCards = lockCanvas(join(legacy, 'cards.sqlite'));
      cpSync(legacy, temporary, { recursive: true, filter: source => !source.endsWith('.lock') });
      // Includes any remaining SQLite WAL/SHM files: preserve the full stopped
      // database, not merely the main file. No default stores open until rename.
      renameSync(temporary, directory);
      migrated = true;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      unlockCards(); unlockCanvas();
    }
  }
  return {
    stateFile: resolve(env.AGENT_CANVAS_STATE_FILE || join(directory, 'canvas.json')),
    cardsFile: resolve(env.AGENT_CANVAS_CARDS_FILE || join(directory, 'cards.sqlite')),
    migrated,
  };
}
