import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createApp } from './index.js';

function fakeSpawn(_bin, args, options) {
  const child = new EventEmitter();
  child.args = args; child.options = options; child.inputs = []; child.resizes = [];
  child.onData = (fn) => { child.on('data', fn); };
  child.onExit = (fn) => { child.on('exit', fn); };
  child.write = (data) => child.inputs.push(data);
  child.resize = (cols, rows) => child.resizes.push({ cols, rows });
  child.kill = () => { child.emit('exit', { exitCode: 0, signal: 15 }); };
  fakeSpawn.children.push(child);
  return child;
}
fakeSpawn.children = [];

const nextMessage = (ws) => new Promise(resolve => ws.once('message', data => resolve(data.toString())));

test('Pi PTY lifecycle, terminal I/O, delegation, and layout', async () => {
  fakeSpawn.children = [];
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-sessions-'));
  await mkdir(join(sessionsRoot, 'project'));
  for (const name of ['one.jsonl', 'two.jsonl']) {
    await writeFile(join(sessionsRoot, 'project', name), JSON.stringify({ type: 'session', cwd: process.cwd() }) + '\n' + '{"type":"message","message":{"content":"not read"}}\n');
  }
  await writeFile(join(sessionsRoot, 'project', 'invalid.jsonl'), 'not json\n');
  const app = createApp({ port: 0, spawnAgent: fakeSpawn, sessionsRoot });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  let ws;
  try {
    const docs = await fetch(base + '/api/docs');
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get('content-type'), /text\/markdown/);
    const guide = await docs.text();
    assert.match(guide, /POST \/api\/agents/);
    assert.ok(guide.includes(`curl -fsS "${base}/api/state"`));
    assert.ok(!guide.includes('$AGENT_CANVAS_URL'));
    const browserGuide = await fetch(base + '/api/docs?origin=http%3A%2F%2F127.0.0.1%3A5173');
    assert.ok((await browserGuide.text()).includes('curl -fsS "http://127.0.0.1:5173/api/state"'));
    const spoofedGuide = await fetch(base + '/api/docs?origin=https%3A%2F%2Funtrusted.example');
    assert.ok((await spoofedGuide.text()).includes(`curl -fsS "${base}/api/state"`));
    const { data: saved } = await request('/api/session-workdirs');
    assert.deepEqual(saved.workdirs.map(({ path, sessionCount }) => ({ path, sessionCount })), [{ path: process.cwd(), sessionCount: 2 }]);
    assert.equal((await request('/api/agents', 'POST', { name: 'test', task: 'hi', workdir: '/definitely/missing' })).status, 400);
    const first = (await request('/api/agents', 'POST', { name: 'parent', task: 'hello', workdir: process.cwd() })).data;
    assert.equal(first.status, 'running');
    assert.equal(fakeSpawn.children[0].options.cwd, process.cwd());
    assert.deepEqual(fakeSpawn.children[0].args.slice(-2), ['--', 'hello']);
    assert.ok(!fakeSpawn.children[0].args.includes('--no-session'));
    assert.equal((await request('/api/agents', 'POST', { name: 'invalid', workdir: process.cwd(), mode: 'unknown' })).status, 400);
    assert.equal((await request('/api/agents', 'POST', { name: 'invalid', workdir: process.cwd(), task: '  ' })).status, 400);
    const blank = (await request('/api/agents', 'POST', { name: 'Blank session', workdir: process.cwd() })).data;
    assert.equal(blank.task, '');
    assert.ok(!fakeSpawn.children[1].args.includes('--'));
    assert.ok(fakeSpawn.children[1].args.includes('--name'));
    const resumed = (await request('/api/agents', 'POST', { name: 'Earlier work', workdir: process.cwd(), mode: 'resume' })).data;
    assert.equal(resumed.mode, 'resume');
    assert.equal(resumed.task, '');
    assert.ok(fakeSpawn.children[2].args.includes('--resume'));
    assert.ok(!fakeSpawn.children[2].args.includes('--no-session'));
    assert.ok(!fakeSpawn.children[2].args.includes('--name'));
    assert.equal((await request('/api/agents', 'POST', { name: 'invalid', workdir: process.cwd(), mode: 'resume', task: 'ignored?' })).status, 400);
    const second = (await request('/api/agents', 'POST', { name: 'child', task: 'help', workdir: process.cwd(), parentId: first.id })).data;
    assert.equal(app.snapshot().edges[0].target, second.id);
    fakeSpawn.children[0].emit('data', '\u001b[32mHello\u001b[0m');
    assert.match(app.snapshot().agents[0].output, /Hello/);
    ws = new WebSocket(base.replace('http', 'ws') + `/api/terminal/${first.id}`);
    assert.equal(await nextMessage(ws), '\u001b[32mHello\u001b[0m');
    const received = nextMessage(ws);
    fakeSpawn.children[0].emit('data', ' more');
    assert.equal(await received, ' more');
    ws.send(JSON.stringify({ type: 'input', data: 'test\r' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(fakeSpawn.children[0].inputs, ['test\r']);
    assert.deepEqual(fakeSpawn.children[0].resizes, [{ cols: 80, rows: 24 }]);
    await request(`/api/agents/${first.id}`, 'PATCH', { note: 'Investigating', x: 50, width: 520 });
    assert.equal(app.snapshot().agents[0].note, 'Investigating');
    assert.equal(app.snapshot().agents[0].width, 520);
    assert.equal((await request(`/api/agents/${first.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/api/agents/${first.id}/stop`, 'POST')).status, 200);
    assert.equal(app.snapshot().agents[0].status, 'stopped');
    assert.equal(app.snapshot().edges.length, 1);
    assert.equal((await request(`/api/agents/${first.id}`, 'DELETE')).status, 200);
    assert.ok(!app.snapshot().agents.some(agent => agent.id === first.id));
    assert.equal(app.snapshot().edges.length, 0);
    assert.equal((await request(`/api/agents/${first.id}`, 'DELETE')).status, 404);
  } finally { ws?.terminate(); await app.close(); await rm(sessionsRoot, { recursive: true, force: true }); }
});
