import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from './index.js';

function spawner() {
  const children = [];
  const spawn = (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, inputs: [], onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write: data => child.inputs.push(data), kill: () => child.emit('exit', { exitCode: 0, signal: 15 }) });
    children.push(child);
    return child;
  };
  return { spawn, children };
}
const request = async (app, path, body, method = 'POST') => {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

test('autosave, exact session restore, stopped nodes, session switches, reset and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-persist-'));
  const file = join(dir, 'canvas.json');
  const session = join(dir, 'conversation.jsonl');
  await writeFile(session, JSON.stringify({ type: 'session', version: 3, id: 'session-1', cwd: dir }) + '\n');
  const one = spawner();
  let app = createApp({ port: 0, stateFile: file, spawnAgent: one.spawn });
  try {
    await app.listen();
    const parent = (await request(app, '/agents', { name: 'A', workdir: dir, task: 'DO NOT REPLAY' })).data;
    const child = (await request(app, '/agents', { name: 'B', workdir: dir, parentId: parent.id })).data;
    const token = one.children[0].options.env.AGENT_CANVAS_RUN;
    assert.equal((await request(app, `/agents/${parent.id}/session`, { runToken: 'stale', sessionId: 'session-1', sessionFile: session })).status, 409);
    assert.equal((await request(app, `/agents/${parent.id}/session`, { runToken: token, sessionId: 'session-1', sessionFile: session })).status, 200);
    await request(app, `/agents/${child.id}/stop`, {});
    await request(app, '/notes', { title: 'Plan', text: 'Keep this', x: 40, y: 70 });
    await request(app, `/agents/${parent.id}`, { name: 'Renamed', x: 99 }, 'PATCH');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).agents[0].name, 'Renamed');
    await app.close();
    await app.close(); // Repeated shutdown must not persist shutdown-induced stopped states.
    assert.equal(JSON.parse(await readFile(file, 'utf8')).agents[0].status, 'running');
    const two = spawner();
    app = createApp({ port: 0, stateFile: file, spawnAgent: two.spawn });
    await app.listen();
    assert.equal(two.children.length, 1);
    assert.deepEqual(two.children[0].args.slice(0, 2), ['--session', session]);
    assert.ok(!two.children[0].args.includes('DO NOT REPLAY'));
    assert.ok(!two.children[0].args.includes('--'));
    assert.deepEqual(two.children[0].inputs, []);
    assert.equal(app.snapshot().agents[0].id, parent.id);
    assert.equal(app.snapshot().agents[0].x, 99);
    assert.equal(app.snapshot().agents[1].status, 'stopped');
    assert.equal(app.snapshot().edges[0].target, child.id);
    assert.equal(app.snapshot().notes[0].text, 'Keep this');
    assert.equal((await request(app, '/canvas/reset', {})).status, 400);
    assert.equal((await request(app, '/canvas/reset', { confirm: true })).status, 200);
    assert.equal(app.snapshot().agents.length, 0);
    assert.equal(app.snapshot().notes.length, 0);
    assert.equal(app.snapshot().edges.length, 0);
    assert.equal((await request(app, `/agents/${parent.id}/session`, { runToken: token, sessionId: 'session-1', sessionFile: session })).status, 404);
    assert.ok(await readFile(session, 'utf8'));
    await app.close();
    app = createApp({ port: 0, stateFile: file, spawnAgent: two.spawn });
    await app.listen();
    assert.equal(app.snapshot().agents.length, 0);
    assert.equal(two.children.length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('missing session uses picker, failed exact launch falls back once, missing cwd keeps node', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-restore-'));
  const file = join(dir, 'canvas.json');
  const session = join(dir, 'session.jsonl');
  await writeFile(session, JSON.stringify({ type: 'session', id: 's' }) + '\n');
  const makeAgent = (id, workdir, sessionFile) => ({ id, workdir, sessionFile, sessionId: 's', name: id, task: 'NEVER SEND', note: '', output: '', status: 'running', x: 0, y: 0, width: 440, height: 320 });
  await writeFile(file, JSON.stringify({ version: 1, agents: [makeAgent('exact', dir, session), makeAgent('missing', dir, join(dir, 'missing')), makeAgent('bad-cwd', join(dir, 'gone'), session)], notes: [], edges: [] }));
  const mock = spawner();
  const app = createApp({ port: 0, stateFile: file, spawnAgent: mock.spawn });
  try {
    await app.listen();
    assert.equal(mock.children.length, 2);
    assert.equal(mock.children[1].args[0], '--resume');
    assert.equal(app.snapshot().agents[2].status, 'stopped');
    assert.match(app.snapshot().agents[2].restoreWarning, /directory/);
    mock.children[0].emit('exit', { exitCode: 1 });
    assert.equal(mock.children.length, 3);
    assert.equal(mock.children[2].args[0], '--resume');
    mock.children[2].emit('exit', { exitCode: 1 });
    assert.equal(mock.children.length, 3);
    for (const child of mock.children) assert.ok(!child.args.includes('NEVER SEND'));
    assert.equal((await request(app, '/agents/exact/resume', {})).status, 200);
    assert.equal(mock.children.length, 4);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('save errors are visible without claiming reset was saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-save-error-'));
  const file = join(dir, 'canvas.json');
  const app = createApp({ port: 0, stateFile: file, spawnAgent: spawner().spawn });
  try {
    await app.listen();
    // Simulate external corruption while the server is running. Never overwrite it.
    await writeFile(file, '{broken');
    await request(app, '/notes', { text: 'Keep in memory' });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(app.snapshot().persistence.error);
    assert.equal(app.snapshot().notes.length, 1);
    assert.equal((await request(app, '/canvas/reset', { confirm: true })).status, 500);
    assert.equal(await readFile(file, 'utf8'), '{broken');
    await rm(file); // Explicit recovery permits a subsequent save.
    await request(app, '/notes', { text: 'Recovered' });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(app.snapshot().persistence.error, '');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('corrupt save fails closed without spawning or overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-corrupt-'));
  const file = join(dir, 'canvas.json');
  await writeFile(file, '{broken');
  const mock = spawner();
  const app = createApp({ port: 0, stateFile: file, spawnAgent: mock.spawn });
  try {
    await assert.rejects(app.listen(), /Original file preserved/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
    assert.equal(mock.children.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
