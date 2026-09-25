import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateCanvas(value) {
  const fail = () => { throw new Error('Invalid or unsupported Canvas save file'); };
  if (!value || value.version !== 1) fail();
  const ids = new Set();
  for (const kind of ['agents', 'notes', 'edges']) {
    if (!Array.isArray(value[kind])) fail();
    for (const item of value[kind]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail();
      ids.add(item.id);
      if (kind !== 'edges' && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key]))) fail();
      if (kind !== 'edges' && (item.width < 160 || item.height < 160)) fail();
      if (kind === 'agents' && (!['name', 'workdir', 'task', 'note', 'output'].every(key => typeof item[key] === 'string') || !['running', 'stopping', 'stopped'].includes(item.status))) fail();
      if (kind === 'agents' && item.sessionFile != null && typeof item.sessionFile !== 'string') fail();
      if (kind === 'notes' && (typeof item.text !== 'string' || typeof item.title !== 'string')) fail();
      if (kind === 'edges' && (item.type !== 'delegates' || typeof item.label !== 'string')) fail();
    }
  }
  const agents = new Set(value.agents.map(agent => agent.id));
  if (value.edges.some(edge => !agents.has(edge.source) || !agents.has(edge.target) || edge.source === edge.target)) fail();
  return value;
}

// Prevent two local servers (even on different ports) from restoring the same
// conversations and overwriting the same save. Recover locks left by dead PIDs.
export function lockCanvas(file) {
  if (!file) return () => {};
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeFileSync(fd, owner); } finally { closeSync(fd); }
      return () => { if (existsSync(lock) && readFileSync(lock, 'utf8') === owner) unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(readFileSync(lock, 'utf8')).pid; } catch { /* fail closed on incomplete lock */ }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Cannot read Canvas lock ${lock}; inspect it before removing it manually`);
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(lock); continue; } }
      throw new Error(`Canvas is already open in process ${pid}: ${file}`);
    }
  }
  throw new Error(`Could not acquire Canvas lock: ${file}`);
}

export function loadCanvas(file) {
  if (!file || !existsSync(file)) return null;
  try { return validateCanvas(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Cannot load Canvas ${file}: ${error.message}. Original file preserved; check ${file}.bak before recovering manually.`); }
}

export function saveCanvas(file, state) {
  if (!file) return;
  const value = validateCanvas({ ...state, version: 1 });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  // Never back up an invalid primary over the last known-good backup.
  if (existsSync(file)) {
    validateCanvas(JSON.parse(readFileSync(file, 'utf8')));
    copyFileSync(file, `${file}.bak.tmp`);
    renameSync(`${file}.bak.tmp`, `${file}.bak`);
  }
  renameSync(temporary, file);
}
