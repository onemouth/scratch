import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from './index.js';

function fakeSpawn(_bin, _args, options) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.cwd = options.cwd;
  child.kill = () => { child.emit('exit', 0, 'SIGTERM'); return true; };
  fakeSpawn.children.push(child);
  return child;
}
fakeSpawn.children = [];

test('lifecycle, delegation, prompts, layout, and streamed output', async () => {
  fakeSpawn.children = [];
  const app = createApp({ port: 0, spawnAgent: fakeSpawn });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const invalid = await request('/api/agents', 'POST', { name: 'test', task: 'hi', workdir: '/definitely/missing' });
    assert.equal(invalid.status, 400);
    const first = (await request('/api/agents', 'POST', { name: 'parent', task: 'hello', workdir: process.cwd() })).data;
    assert.equal(first.status, 'starting');
    assert.equal(fakeSpawn.children[0].cwd, process.cwd());
    const second = (await request('/api/agents', 'POST', { name: 'child', task: 'help', workdir: process.cwd(), parentId: first.id })).data;
    assert.equal(app.snapshot().edges.length, 1);
    assert.equal(app.snapshot().edges[0].source, first.id);
    assert.equal(app.snapshot().edges[0].target, second.id);
    fakeSpawn.children[0].stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    fakeSpawn.children[0].stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } }) + '\n');
    fakeSpawn.children[0].stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
    assert.equal(app.snapshot().agents[0].status, 'idle');
    assert.match(app.snapshot().agents[0].output, /done/);
    await request(`/api/agents/${first.id}`, 'PATCH', { note: 'Investigating', x: 50, width: 520 });
    assert.equal(app.snapshot().agents[0].note, 'Investigating');
    assert.equal(app.snapshot().agents[0].width, 520);
    assert.equal((await request(`/api/agents/${first.id}/prompt`, 'POST', { message: 'next step' })).status, 200);
    assert.equal((await request(`/api/agents/${first.id}/stop`, 'POST')).status, 200);
    assert.equal(app.snapshot().agents[0].status, 'stopped');
    assert.equal((await request(`/api/agents/${first.id}/prompt`, 'POST', { message: 'again' })).status, 400);
    assert.equal(app.snapshot().edges.length, 1);
    await request(`/api/edges/${app.snapshot().edges[0].id}`, 'DELETE');
    assert.equal(app.snapshot().edges.length, 0);
  } finally { await app.close(); }
});
