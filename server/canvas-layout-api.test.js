import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from './index.js';
import { queryFixture } from '../scripts/tests/query-fixture.js';

function spawnFixture() {
  const children = [];
  return { children, spawn: (_bin, _args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), kill: () => child.emit('exit', { exitCode: 0 }) });
    children.push(child); return child;
  } };
}

test('Agent Canvas creation/updates validate collisions atomically and preserve default placement/Card Box', async () => {
  const fixture = spawnFixture(), app = createApp({ port: 0, spawnAgent: fixture.spawn });
  await app.listen();
  const request = async (path, method = 'GET', body, human = false) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(human ? { 'X-Canvas-Layout': 'human' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const note = (await request('/notes', 'POST', { text: 'Human-created obstacle', x: 0, y: 0, width: 200, height: 200 }, true)).data;
    const before = app.snapshot();
    const failedCard = await request('/cards', 'POST', { content: 'No partial library/view insert', x: 100, y: 100 });
    assert.equal(failedCard.status, 409); assert.equal(failedCard.data.code, 'LAYOUT_CONFLICT');
    assert.deepEqual(failedCard.data.conflicts, [{ kind: 'note', id: note.id, x: 0, y: 0, width: 200, height: 200 }]);
    assert.deepEqual(app.snapshot().cards, before.cards);
    assert.deepEqual(app.snapshot().cardBox.placements, before.cardBox.placements);
    assert.equal((await request('/agents', 'POST', { name: 'Rejected', workdir: process.cwd(), x: 100, y: 100 })).status, 409);
    assert.equal(fixture.children.length, 0, 'Collision is checked before spawning a PTY');
    assert.equal((await request('/agents', 'POST', { name: 'Bad', workdir: process.cwd(), x: null })).status, 400);
    assert.equal((await request('/notes', 'POST', { x: 200, width: 159 })).status, 400);
    assert.equal((await request('/cards', 'POST', { content: 'bad', place: false, x: 900 })).status, 400);
    const card = (await request('/cards', 'POST', { content: 'Touching edges is okay', x: 200, y: 0, width: 240, height: 240 })).data;
    assert.equal(app.snapshot().cardPlacements.find(p => p.id === card.id).x, 200);
    const cardBoxBefore = structuredClone(app.snapshot().cardBox.placements);
    assert.equal((await request(`/card-placements/${card.id}`, 'PATCH', { x: 199 })).status, 409);
    assert.equal(app.snapshot().cardPlacements.find(p => p.id === card.id).x, 200);
    assert.equal((await request(`/card-placements/${card.id}`, 'PATCH', { x: -240, y: 0 })).status, 200);
    assert.deepEqual(app.snapshot().cardBox.placements, cardBoxBefore, 'Agent Canvas card edits never alter Card Box');
    const agent = (await request('/agents', 'POST', { name: 'Agent', workdir: process.cwd(), x: 600, y: 0, width: 320, height: 240 })).data;
    assert.equal(agent.width, 320); assert.equal(agent.x, 600);
    assert.equal(app.snapshot().agents.find(a => a.id === agent.id).suppressAutoFocus, true);
    assert.equal(app.snapshot(false).agents.find(a => a.id === agent.id).suppressAutoFocus, undefined, 'Focus hints are ephemeral, not persisted');
    assert.equal((await request(`/agents/${agent.id}`, 'PATCH', { name: 'Must not change', x: 0 })).status, 409);
    assert.equal(app.snapshot().agents.find(a => a.id === agent.id).name, 'Agent');
    assert.equal((await request(`/agents/${agent.id}`, 'PATCH', { width: 319 })).status, 400);
    assert.equal((await request(`/agents/${agent.id}`, 'PATCH', { width: 400, y: 500 })).status, 200);
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { text: 'Must not save', x: -100 })).status, 409);
    assert.equal(app.snapshot().notes[0].text, 'Human-created obstacle');
    // Human gestures may overlap; the next API edit must completely resolve it.
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { x: -100 }, true)).status, 200);
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { x: -50 })).status, 409);
    assert.equal((await request(`/notes/${note.id}`, 'PATCH', { x: 0 })).status, 200);
    const interactive = (await request('/cards', 'POST', { type: 'interactive', title: 'SVG', html: '<svg></svg>', x: 1000, y: 0, width: 320, height: 240 })).data;
    assert.equal((await request(`/card-placements/${interactive.id}`, 'PATCH', { width: 319 })).status, 400);
    assert.equal((await request(`/cards/${card.id}/placement`, 'POST', { x: 9999 })).status, 409);
    const libraryOnly = (await request('/cards', 'POST', { content: 'Library only', place: false })).data;
    assert.equal((await request(`/cards/${libraryOnly.id}/placement`, 'POST', { x: 0, y: 0 })).status, 409);
    assert.equal((await request(`/cards/${libraryOnly.id}/placement`, 'POST', { x: 1500, y: 0 })).status, 200);
    const box = (await request('/card-box/agent', 'POST', {})).data;
    assert.equal((await request(`/agents/${box.id}`, 'PATCH', { x: 3000 })).status, 403);
    const layout = await queryFixture(fixture.children[0]).query('layout');
    assert.ok(!layout.objects.some(o => o.id === box.id));
    assert.ok(layout.objects.some(o => o.kind === 'card' && o.id === card.id));
    // No explicit layout retains old defaults, even when they overlap.
    assert.equal((await request('/notes', 'POST', { text: 'Default placement' })).status, 201);
    assert.equal((await request('/cards', 'POST', { content: 'Default placement' })).status, 201);
  } finally { await app.close(); }
});

test('human gestures block API layout only until every browser lease is released', async () => {
  const app = createApp({ port: 0 }); await app.listen();
  const request = async (path, body, human = false, method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(human ? { 'X-Canvas-Layout': 'human' } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const note = (await request('/notes', { text: 'Note' })).data;
    const path = `/canvas/layout-interactions/note/${note.id}`;
    assert.equal((await request(path, { owner: 'tab-a', action: 'start' })).status, 403);
    assert.equal((await request(path, { owner: 'tab-a', action: 'start' }, true)).status, 200);
    assert.equal((await request(path, { owner: 'tab-b', action: 'start' }, true)).status, 200);
    const busy = await request(`/notes/${note.id}`, { x: 1000 }, false, 'PATCH');
    assert.equal(busy.status, 409); assert.equal(busy.data.code, 'LAYOUT_BUSY');
    assert.equal((await request(`/notes/${note.id}`, { text: 'Metadata is still editable' }, false, 'PATCH')).status, 200);
    assert.equal((await request(`/notes/${note.id}`, { x: 1000 }, true, 'PATCH')).status, 200);
    await request(path, { owner: 'tab-a', action: 'end' }, true);
    assert.equal((await request(`/notes/${note.id}`, { x: 1500 }, false, 'PATCH')).status, 409);
    await request(path, { owner: 'tab-b', action: 'end' }, true);
    assert.equal((await request(`/notes/${note.id}`, { x: 1500 }, false, 'PATCH')).status, 200);
    await request(path, { owner: 'tab-a', action: 'start' }, true);
    await request(`/notes/${note.id}`, {}, true, 'DELETE');
    assert.equal((await request(path, { owner: 'tab-a', action: 'renew' }, true)).status, 404);
  } finally { await app.close(); }
});
