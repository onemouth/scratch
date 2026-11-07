import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { nativeMemory, memoryName, memoryPage, openCanvasMemory } from './canvas-memory.js';

const built = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: built ? false : 'Run npm run test:shm to build the native addon' }, fn);
const fixture = new URL('../scripts/tests/shm-child.mjs', import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

nativeTest('native memory validates names, numbers and handles; only exclusive creators can write', () => {
  const native = nativeMemory(), name = memoryName();
  for (const value of [NaN, Infinity, 1.5, -1, 0, 4097, 2 ** 32 + 4096, 4194312, '4096']) {
    assert.throws(() => native.create(name, value), { code: 'SHM_ARGUMENT' });
  }
  for (const value of ['', '/wrong-name', '/scsh-a/b', '/scsh-a\0b', '/scsh-' + 'a'.repeat(30)]) {
    assert.throws(() => native.create(value, 4096), { code: 'SHM_ARGUMENT' });
  }
  assert.throws(() => native.read({}), { code: 'SHM_ARGUMENT' });
  assert.throws(() => native.open(name), { code: 'SHM_MISSING' });
  const writer = native.create(name, 4096);
  let reader;
  try {
    assert.throws(() => native.create(name, 4096), { code: 'SHM_EXISTS' });
    assert.throws(() => native.open(name), { code: 'SHM_NOT_READY' });
    native.write(writer, Buffer.from('first 甲🙂'));
    reader = native.open(name);
    assert.equal(native.read(reader).toString(), 'first 甲🙂');
    assert.throws(() => native.write(reader, Buffer.from('bad')), { code: 'SHM_READ_ONLY' });
    assert.throws(() => native.touch(reader), { code: 'SHM_READ_ONLY' });
    assert.throws(() => native.invalidate(reader), { code: 'SHM_READ_ONLY' });
    assert.throws(() => native.write(writer, Buffer.alloc(4097)), { code: 'SHM_CAPACITY' });
    assert.throws(() => native.read(reader), { code: 'SHM_UNAVAILABLE' });
    native.write(writer, Buffer.alloc(4096, 42));
    assert.equal(native.read(reader).length, 4096);
    native.close(writer); native.close(writer);
    assert.throws(() => native.read(reader), { code: 'SHM_CLOSED' });
    assert.throws(() => native.read(writer), { code: 'SHM_CLOSED' });
    assert.throws(() => native.open(name), { code: 'SHM_MISSING' });
  } finally { if (reader) native.close(reader); native.close(writer); }
});

nativeTest('independent writer process and concurrent reader never expose torn Unicode/JSON snapshots', async () => {
  const native = nativeMemory(), name = memoryName();
  const child = fork(fixture, ['writer', name], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let reader;
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) }); reader = native.open(name);
    let finished = false, successful = 0, busy = 0;
    const done = once(child, 'message', { signal: AbortSignal.timeout(15000) }).then(() => { finished = true; });
    child.send('churn');
    do {
      try {
        const result = JSON.parse(native.read(reader));
        assert.equal(result.payload, (result.n % 2 ? '甲' : '乙').repeat(20000)); successful++;
      } catch (error) { if (error.code !== 'SHM_BUSY') throw error; busy++; }
      await new Promise(resolve => setImmediate(resolve));
    } while (!finished);
    await done;
    assert.ok(successful > 1, `successful=${successful}, busy=${busy}`);
    assert.equal(JSON.parse(native.read(reader)).n, 400);
    const exit = once(child, 'exit'); child.send('close'); await exit;
    assert.throws(() => native.read(reader), { code: 'SHM_CLOSED' });
  } finally { if (reader) native.close(reader); if (child.exitCode === null) child.kill('SIGKILL'); native.remove(name); }
});

nativeTest('killed publisher expires instead of presenting old state forever; cleanup is explicit', async () => {
  const native = nativeMemory(), name = memoryName();
  const child = fork(fixture, ['writer', name], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let reader;
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) }); reader = native.open(name);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    await sleep(5150);
    assert.throws(() => native.read(reader), { code: 'SHM_STALE' });
    native.remove(name);
    assert.throws(() => native.open(name), { code: 'SHM_MISSING' });
  } finally { if (reader) native.close(reader); if (child.exitCode === null) child.kill('SIGKILL'); native.remove(name); }
});

nativeTest('generation pinning and native handle GC require no V8-specific ABI or global region map', async () => {
  const native = nativeMemory(), name = memoryName(), writer = native.create(name, 4096);
  try {
    native.write(writer, Buffer.from(JSON.stringify({ protocolVersion: 1, serverEpoch: 'first', revision: 1,
      agents: [], notes: [], cards: [], edges: [], cardPlacements: [] })));
    const reader = openCanvasMemory(name, 'second');
    try { assert.throws(() => reader.read(), { code: 'SHM_VERSION' }); } finally { reader.close(); }
  } finally { native.close(writer); }
  const code = `import { nativeMemory, memoryName } from './shared/canvas-memory.js';
    const n=nativeMemory(), name=memoryName(); (()=>{ const h=n.create(name,4096); n.write(h,Buffer.from('x')); })();
    for(let i=0;i<20;i++){ global.gc(); await new Promise(r=>setTimeout(r,5)); }
    try { n.open(name); process.exitCode=1; } catch(e) { if(e.code!=='SHM_MISSING') throw e; } finally {n.remove(name);}`;
  await promisify(execFile)(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], { timeout: 10000 });
});

nativeTest('incomplete initialization, invalid headers and interrupted publications fail boundedly', async () => {
  const native = nativeMemory(), helper = new URL('../scripts/tests/shm-corrupt.py', import.meta.url).pathname;
  const mutate = (...args) => promisify(execFile)(process.env.PYTHON || 'python3', [helper, ...args], { timeout: 5000 });
  const name = memoryName();
  try {
    await mutate('empty', name);
    assert.throws(() => native.open(name), { code: 'SHM_NOT_READY' });
  } finally { native.remove(name); }
  for (const [field, value, code] of [[1, 99, 'SHM_VERSION'], [4, 1, 'SHM_BUSY'], [5, 9999999, 'SHM_CORRUPT']]) {
    const name = memoryName(), writer = native.create(name, 4096);
    let reader;
    try {
      native.write(writer, Buffer.from('{}')); reader = native.open(name);
      await mutate('header', name, String(field), String(value));
      if (field === 1) assert.throws(() => native.open(name), { code });
      else assert.throws(() => native.read(reader), { code });
    } finally { if (reader) native.close(reader); native.close(writer); }
  }
});

test('memory tool pagination preserves valid JSON, bounds results and exposes explicit cursors', () => {
  const state = { protocolVersion: 1, serverEpoch: 'x', revision: 1, agents: Array.from({ length: 60 }, (_, id) => ({ id, note: '甲'.repeat(500) })),
    notes: [], cards: [], edges: [], cardPlacements: [] };
  const result = memoryPage(state, { section: 'agents', limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 40000);
  assert.ok(result.sections.agents.nextOffset > 0);
  assert.ok(memoryPage(state, { section: 'agents', offset: result.sections.agents.nextOffset }).sections.agents.items.length > 0);
  for (const params of [{ section: 'bad' }, { limit: 0 }, { offset: -1 }, { limit: 1.5 }]) assert.throws(() => memoryPage(state, params));
});
