import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './index.js';
import { createCanvasMemory, canvasMemoryProjection } from './canvas-memory.js';
import { openCanvasMemory, nativeMemory } from '../shared/canvas-memory.js';
import canvasMemoryExtension, { canvasReadTool } from './pi-canvas-memory.js';

const built = ['darwin', 'linux'].includes(process.platform) && existsSync(new URL('../native/canvas-shm/build/Release/canvas_shm.node', import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: built ? false : 'Run npm run test:shm to build the native addon' }, fn);
const empty = () => ({ agents: [], edges: [], notes: [], cards: [], cardPlacements: [] });

nativeTest('Scratch publishes isolated state and passes a read-only memory tool to Pi without changing HTTP/PTY behavior', async () => {
  const children = [];
  const app = createApp({ port: 0, sharedMemory: true, spawnAgent: (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn),
      write() {}, resize() {}, kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } });
  let reader;
  try {
    await app.listen();
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const request = async (path, body) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status < 300, true, await res.clone().text()); return res.json();
    };
    const agent = await request('/agents', { name: 'Shared fixture', workdir: process.cwd(), task: 'PRIVATE PROMPT' });
    const child = children[0], { name, epoch } = app.sharedMemory;
    assert.equal(child.options.env.AGENT_CANVAS_SHM_NAME, name);
    assert.equal(child.options.env.AGENT_CANVAS_SHM_EPOCH, epoch);
    assert.ok(child.args.some(arg => arg.endsWith('/pi-canvas-memory.js')));
    const card = await request('/cards', { type: 'interactive', title: 'Shared title', html: '<p>PRIVATE HTML</p>', javascript: 'PRIVATE_JS()', place: true });
    const note = await request('/notes', { title: 'Note', text: 'Visible note' });
    child.emit('data', '\u001b[31mPRIVATE TERMINAL\u001b[0m');
    // Activity reports publish immediately, including preceding metadata changes.
    await request(`/agents/${agent.id}/activity`, { runToken: child.options.env.AGENT_CANVAS_RUN, seq: 1, state: 'working' });
    reader = openCanvasMemory(name, epoch);
    const snapshot = reader.read(), raw = JSON.stringify(snapshot);
    assert.equal(snapshot.agents[0].activity, 'working');
    assert.equal(snapshot.notes.find(value => value.id === note.id).summary, 'Visible note');
    assert.equal(snapshot.cards.find(value => value.id === card.id).summary, 'Shared title');
    for (const forbidden of ['PRIVATE PROMPT', 'PRIVATE TERMINAL', 'PRIVATE HTML', 'PRIVATE_JS', child.options.env.AGENT_CANVAS_RUN]) assert.equal(raw.includes(forbidden), false);
    assert.equal((await (await fetch(`${base}/agents/${agent.id}/output`)).json()).output.includes('PRIVATE TERMINAL'), true);
    const fixture = new URL('../scripts/tests/shm-child.mjs', import.meta.url);
    const { stdout } = await promisify(execFile)(process.execPath, [fixture.pathname, 'tool', name, epoch], { timeout: 10000 });
    const result = JSON.parse(stdout);
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).sections.agents.items[0].name, 'Shared fixture');
    await app.close();
    assert.throws(() => reader.read(), { code: 'SHM_CLOSED' });
  } finally { reader?.close(); await app.close(); }
});

nativeTest('publisher rejects overflow without serving stale state, recovers on smaller update, and never follows another generation', () => {
  const errors = []; let state = empty();
  const first = createCanvasMemory({ capacity: 4096, getState: () => state, onError: value => errors.push(value) });
  const old = openCanvasMemory(first.name, first.epoch);
  try {
    const revision = old.read().revision;
    state = { ...empty(), agents: Array.from({ length: 100 }, (_, id) => ({ id: String(id), note: 'x'.repeat(500) })) };
    first.publish(); assert.equal(errors.length, 1);
    assert.throws(() => old.read(), { code: 'SHM_UNAVAILABLE' });
    state = empty(); first.publish(); assert.ok(old.read().revision > revision);
    first.close();
    const second = createCanvasMemory({ getState: empty });
    try {
      assert.notEqual(second.name, first.name); assert.notEqual(second.epoch, first.epoch);
      assert.throws(() => old.read(), { code: 'SHM_CLOSED' });
      const current = openCanvasMemory(second.name, second.epoch);
      try { assert.equal(current.read().serverEpoch, second.epoch); } finally { current.close(); }
    } finally { second.close(); }
  } finally { old.close(); first.close(); }
});

nativeTest('shared memory defaults on, supports environment opt-out and explicit app override', async () => {
  const previous = process.env.AGENT_CANVAS_SHARED_MEMORY;
  try {
    delete process.env.AGENT_CANVAS_SHARED_MEMORY;
    const enabled = createApp({ port: 0 });
    try { await enabled.listen(); assert.ok(enabled.sharedMemory?.name); } finally { await enabled.close(); }
    process.env.AGENT_CANVAS_SHARED_MEMORY = '0';
    const disabled = createApp({ port: 0 });
    try { await disabled.listen(); assert.equal(disabled.sharedMemory, null); } finally { await disabled.close(); }
    const override = createApp({ port: 0, sharedMemory: true });
    try { await override.listen(); assert.ok(override.sharedMemory?.name); } finally { await override.close(); }
  } finally {
    if (previous === undefined) delete process.env.AGENT_CANVAS_SHARED_MEMORY;
    else process.env.AGENT_CANVAS_SHARED_MEMORY = previous;
  }
});

test('HTTP-only lifecycle skips compilation when explicitly disabled', async () => {
  const script = new URL('../scripts/build-shm.js', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--if-enabled'], {
    env: { ...process.env, AGENT_CANVAS_SHARED_MEMORY: '0', PATH: '' }, timeout: 5000,
  });
  assert.match(stdout, /disabled; skipping native build/);
});

test('projection allowlists data, bounded summaries and no card source or session credentials', () => {
  const result = canvasMemoryProjection({ ...empty(), agents: [{ id: 'a', name: 'Agent', output: 'secret', task: 'secret', sessionFile: 'secret', runToken: 'secret' }],
    notes: [{ id: 'n', text: 'x'.repeat(10000) }], cards: [{ id: 'c', type: 'interactive', title: 'Title', interactive: { html: 'secret' }, assets: ['secret'] }] });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.notes[0].summary.length, 500);
});

test('extension registers without acquiring resources, tool closes readers, validates params and never uses HTTP fallback', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('HTTP forbidden'); };
  let opened = 0, closed = 0;
  try {
    const tool = canvasReadTool({ name: '/scsh-test', epoch: 'one', open: () => {
      opened++; return { read: () => ({ ...empty(), protocolVersion: 1, serverEpoch: 'one', revision: 2 }), close: () => closed++ };
    } });
    assert.equal(opened, 0);
    const result = await tool.execute('x', {}); assert.equal(result.isError, undefined); assert.equal(closed, 1);
    assert.equal((await tool.execute('x', { offset: -1 })).isError, true); assert.equal(closed, 2);
    const control = new AbortController(); control.abort();
    assert.equal((await tool.execute('x', {}, control.signal)).isError, true); assert.equal(opened, 2);
    const missing = canvasReadTool({ name: 'x', epoch: 'one', open: () => { throw Object.assign(new Error('Gone'), { code: 'SHM_MISSING' }); } });
    assert.equal((await missing.execute('x', {})).details.code, 'SHM_MISSING');
    const keys = ['AGENT_CANVAS_SHM_NAME', 'AGENT_CANVAS_SHM_EPOCH'];
    const previous = keys.map(key => process.env[key]); let registered;
    try {
      process.env[keys[0]] = '/scsh-test'; process.env[keys[1]] = 'one';
      canvasMemoryExtension({ registerTool: value => { registered = value; } });
      assert.equal(registered.name, 'canvas_read');
    } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
  } finally { globalThis.fetch = originalFetch; }
});
