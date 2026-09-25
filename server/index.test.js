import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  const app = createApp({ port: 0, spawnAgent: fakeSpawn });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  let ws;
  try {
    assert.equal((await request('/api/agents', 'POST', { name: 'test', task: 'hi', workdir: '/definitely/missing' })).status, 400);
    const first = (await request('/api/agents', 'POST', { name: 'parent', task: 'hello', workdir: process.cwd() })).data;
    assert.equal(first.status, 'running');
    assert.equal(fakeSpawn.children[0].options.cwd, process.cwd());
    assert.deepEqual(fakeSpawn.children[0].args.slice(-2), ['--', 'hello']);
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
    assert.equal((await request(`/api/agents/${first.id}/stop`, 'POST')).status, 200);
    assert.equal(app.snapshot().agents[0].status, 'stopped');
    assert.equal(app.snapshot().edges.length, 1);
    await request(`/api/edges/${app.snapshot().edges[0].id}`, 'DELETE');
    assert.equal(app.snapshot().edges.length, 0);
  } finally { ws?.terminate(); await app.close(); }
});
