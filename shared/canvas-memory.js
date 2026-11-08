import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
let binding;
export function nativeMemory() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Canvas shared memory supports macOS/Linux only');
  // No native-to-process-local or HTTP fallback. Loading is lazy so the existing
  // HTTP-only server remains usable without a compiler/native build.
  return binding ??= require('../native/canvas-shm/build/Release/canvas_shm.node');
}
export const memoryName = () => `/scsh-${randomBytes(10).toString('hex')}`;
export const MEMORY_PROTOCOL = 1;
export const DEFAULT_CAPACITY = 1024 * 1024;
// These conditions can clear on the original publisher without replacing any
// process-owned channel. Never follow missing/closed/incompatible generations.
export const transientMemoryError = error => ['SHM_STALE', 'SHM_BUSY', 'SHM_NOT_READY', 'SHM_UNAVAILABLE'].includes(error.code);

export function openCanvasMemory(name, expectedEpoch) {
  const native = nativeMemory();
  const handle = native.open(name);
  return {
    read() {
      const snapshot = JSON.parse(native.read(handle).toString('utf8'));
      if (snapshot.protocolVersion !== MEMORY_PROTOCOL || typeof snapshot.serverEpoch !== 'string' ||
          (expectedEpoch && snapshot.serverEpoch !== expectedEpoch) || !Number.isSafeInteger(snapshot.revision) ||
          !['agents', 'edges', 'notes', 'cards', 'cardPlacements'].every(key => Array.isArray(snapshot[key]))) {
        throw Object.assign(new Error('Incompatible Canvas snapshot or server generation'), { code: 'SHM_VERSION' });
      }
      return snapshot;
    },
    close() { native.close(handle); },
  };
}

// Model-facing pagination is separate from shared-memory capacity. Never return
// a sliced JSON string or silently omit records when a tool result is too large.
export function memoryPage(snapshot, { section = 'all', offset = 0, limit = 20 } = {}) {
  const sections = ['agents', 'edges', 'notes', 'cards', 'cardPlacements'];
  if (!['all', ...sections].includes(section) || !Number.isInteger(offset) || offset < 0 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid section, offset or limit');
  const result = { protocolVersion: snapshot.protocolVersion, serverEpoch: snapshot.serverEpoch,
    revision: snapshot.revision, publishedAt: snapshot.publishedAt, source: 'posix-shared-memory', sections: {} };
  for (const key of section === 'all' ? sections : [section]) {
    const records = snapshot[key];
    const page = result.sections[key] = { total: records.length, offset, items: [], nextOffset: null };
    for (const item of records.slice(offset, offset + limit)) {
      page.items.push(item);
      if (Buffer.byteLength(JSON.stringify(result)) > 40000) { page.items.pop(); break; }
    }
    page.nextOffset = offset + page.items.length < records.length ? offset + page.items.length : null;
    if (page.items.length === 0 && offset < records.length) {
      // A previous collection can consume the total budget. Ask for one section
      // rather than producing an empty page whose cursor never advances.
      throw new Error(`Result exceeds 40 KB; select section "${key}" with a smaller limit`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 40000) throw new Error('Result exceeds 40 KB; select one section with a smaller limit');
  return result;
}
