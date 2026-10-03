import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from './index.js';
import { syncCardBoxPlacements } from './card-box-layout.js';

test('all cards get append-only layouts, including library-only cards', () => {
  const placements = new Map();
  syncCardBoxPlacements(placements, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(placements.get('a').x, 540);
  const original = { ...placements.get('b'), x: 1000, y: 900, width: 800 };
  placements.set('b', original);
  syncCardBoxPlacements(placements, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(placements.get('b'), original);
  const c = placements.get('c');
  assert.ok(!(c.x < original.x + original.width && c.x + c.width > original.x && c.y < original.y + original.height && c.y + c.height > original.y));
  syncCardBoxPlacements(placements, [{ id: 'b' }, { id: 'c' }]);
  assert.equal(placements.has('a'), false);
});

test('Card box singleton, separate layouts, reset isolation and exact-session resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-box-'));
  const stateFile = join(directory, 'canvas.json'), cardsFile = join(directory, 'cards.sqlite');
  const children = [];
  const spawnAgent = (_bin, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { args, options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write() {}, resize() {}, kill() { this.emit('exit', { exitCode: 0 }); } });
    children.push(child);
    return child;
  };
  let app = createApp({ port: 0, stateFile, cardsFile, spawnAgent });
  const request = async (path, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    await app.listen();
    const normal = (await request('/agents', { name: 'Normal', workdir: directory })).data;
    const card = (await request('/cards', { content: 'Shared', place: false })).data;
    assert.equal(app.snapshot().cardPlacements.length, 0);
    assert.equal(app.snapshot().cardBox.placements.length, 1);
    await request('/cards/' + card.id + '/placement', {});
    await request('/card-placements/' + card.id, { x: 2000, width: 600 }, 'PATCH');
    assert.equal(app.snapshot().cardBox.placements[0].x, 540);
    assert.equal(app.snapshot().cardBox.placements[0].width, 340);
    const box = await request('/card-box/agent', {});
    assert.equal(box.status, 201);
    assert.equal(box.data.workspace, 'card-box');
    assert.equal(box.data.workdir, directory);
    assert.equal((await request('/card-box/agent', {})).status, 409);
    assert.equal(children.length, 2);
    assert.equal((await request('/agents', { name: 'Blocked child', workdir: directory, parentId: box.data.id })).status, 400);
    assert.equal(children.length, 2);
    assert.equal((await request('/edges', { source: normal.id, target: box.data.id })).status, 400);
    const sessionFile = join(directory, 'box-session.jsonl');
    await writeFile(sessionFile, JSON.stringify({ type: 'session', id: 'box-session', cwd: directory }) + '\n');
    await request('/agents/' + box.data.id + '/session', { runToken: children[1].options.env.AGENT_CANVAS_RUN, sessionId: 'box-session', sessionFile });
    await request('/card-box/placements/' + card.id, { x: 1200, y: 400, width: 500 }, 'PATCH');
    await app.close();
    app = createApp({ port: 0, stateFile, cardsFile, spawnAgent });
    await app.listen();
    assert.equal(children.length, 4);
    assert.deepEqual(children[3].args.slice(0, 2), ['--session', sessionFile]);
    assert.ok(!children[3].args.includes('--'));
    assert.equal(app.snapshot().cardBox.placements[0].x, 1200);
    assert.equal(app.snapshot().cardBox.placements[0].width, 500);
    assert.equal((await request('/card-box/agent', {})).status, 409);
    await request('/canvas/reset', { confirm: true });
    assert.equal(app.snapshot().agents.length, 1);
    assert.equal(app.snapshot().agents[0].id, box.data.id);
    assert.equal(app.snapshot().agents[0].status, 'running');
    assert.equal(app.snapshot().cardBox.placements.length, 1);
    assert.equal(app.snapshot().cards.length, 1);
    await request('/agents/' + box.data.id + '/stop', {});
    assert.equal((await request('/agents/' + box.data.id, {}, 'DELETE')).status, 409);
    await app.close();
    app = createApp({ port: 0, stateFile, cardsFile, spawnAgent });
    await app.listen();
    assert.equal(children.length, 4); // Stopped box stays stopped.
    assert.equal((await request('/agents/' + box.data.id + '/resume', {})).status, 200);
    assert.equal(children.length, 5);
    assert.deepEqual(children[4].args.slice(0, 2), ['--session', sessionFile]);
    await request('/cards/' + card.id, { confirm: true }, 'DELETE');
    assert.equal(app.snapshot().cardBox.placements.length, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
