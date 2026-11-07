import { readdir, open, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

export async function savedWorkdirs(sessionRoot) {
  let projects;
  try { projects = await readdir(sessionRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const directories = [sessionRoot, ...projects.filter(entry => entry.isDirectory()).map(entry => join(sessionRoot, entry.name))];
  const workdirs = new Map();
  for (const directory of directories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(directory, entry.name);
      try {
        const handle = await open(file, 'r');
        let header;
        try {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const end = buffer.indexOf(10);
          if (end < 0 || end >= bytesRead) continue;
          header = JSON.parse(buffer.toString('utf8', 0, end));
        } finally { await handle.close(); }
        if (header.type !== 'session' || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) continue;
        const cwd = resolve(header.cwd);
        if (!(await stat(cwd)).isDirectory()) continue;
        const { mtimeMs } = await stat(file);
        const item = workdirs.get(cwd) ?? { path: cwd, sessionCount: 0, lastUsed: 0 };
        item.sessionCount++;
        item.lastUsed = Math.max(item.lastUsed, mtimeMs);
        workdirs.set(cwd, item);
      } catch { /* ignore malformed or inaccessible session files */ }
    }
  }
  return [...workdirs.values()].sort((a, b) => b.lastUsed - a.lastUsed || a.path.localeCompare(b.path));
}

