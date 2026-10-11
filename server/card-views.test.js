import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardViews, validateViewState } from './card-views.js';
import { createApp } from './index.js';
import { validateCanvas } from './canvas-store.js';

const a = { id: '2026-01-01-0001' }, b = { id: '2026-01-01-0002' };
test('view migration preserves layout; views have independent membership and placement', () => {
  const original = { id: a.id, cardId: a.id, x: -700, y: 1234, width: 510, height: 620 };
  const views = new CardViews({ placements: [original] }, [a, b]);
  const migrated = views.active;
  assert.equal(migrated.name, '原有 Card box');
  assert.deepEqual(migrated.placements.get(a.id), original);
  assert.equal(migrated.placements.size, 2);
  const empty = views.create({ fromViewId: migrated.id }, [a,b]);
  assert.equal(empty.saved, false); assert.equal(empty.placements.size, 0);
  views.add(empty.id, a, [a,b]); views.add(empty.id, a, [a,b]);
  assert.equal(empty.placements.size, 1);
  empty.placements.get(a.id).x = 800;
  assert.equal(migrated.placements.get(a.id).x, -700);
  views.prune([b]);
  assert.equal(empty.placements.size, 0); assert.equal(migrated.placements.size, 1);
});

test('Unfiled dynamically tracks cards with no user-view membership and retains layout', () => {
  const c = { id: '2026-01-01-0003' }, cards = [a,b,c];
  const views = new CardViews(null, [a,b]);
  const original = views.active, unfiled = [...views.views.values()].find(view => view.system === 'unfiled');
  assert.equal(unfiled.placements.size, 0);
  views.removeCard(original.id, a.id, [a,b]);
  assert.deepEqual([...unfiled.placements.keys()], [a.id]);
  unfiled.placements.get(a.id).x = -321;
  views.add(original.id, a, [a,b]);
  assert.equal(unfiled.placements.size, 0);
  views.removeCard(original.id, a.id, [a,b]);
  assert.equal(unfiled.placements.get(a.id).x, -321);
  views.activate(unfiled.id, { fromViewId: original.id }, [a,b]);
  views.addNew(c, cards);
  assert.deepEqual([...unfiled.placements.keys()], [a.id, c.id]);
  assert.throws(() => views.add(unfiled.id, b, cards), /automatic/);
  assert.throws(() => views.removeCard(unfiled.id, a.id, cards), /automatic/);
  const selected = views.create({ fromViewId: unfiled.id, cardIds: [a.id] }, cards);
  assert.ok(selected.placements.has(a.id)); assert.ok(!unfiled.placements.has(a.id));
  views.remove(selected.id, { confirm: true, fromViewId: selected.id }, cards);
  assert.ok(unfiled.placements.has(a.id));
});

test('schema-3 views gain fixed Unfiled and preserve a conflicting user view', () => {
  const legacy = { revision: 4, activeViewId: 'legacy', views: [{ id: 'legacy', name: 'Unfiled', saved: true, viewport: null, placements: [] }] };
  assert.equal(validateViewState(legacy), legacy);
  assert.throws(() => validateCanvas({ version: 4, agents: [], notes: [], edges: [], cardPlacements: [], cardBox: legacy }), /unsupported/);
  const views = new CardViews(legacy, [a]);
  assert.equal(views.get('legacy').name, 'Unfiled (2)');
  const unfiled = [...views.views.values()].find(view => view.system === 'unfiled');
  assert.equal(unfiled.name, 'Unfiled'); assert.ok(unfiled.placements.has(a.id));
});

test('temporary departure requires explicit choice and is atomic on invalid/stale requests', () => {
  const views = new CardViews(null, [a,b]), original = views.active.id;
  const draft = views.create({ fromViewId: original, name: 'Draft' }, [a,b]);
  const before = views.snapshot();
  assert.throws(() => views.activate(original, { fromViewId: draft.id }, [a,b]), /Save or discard/);
  assert.throws(() => views.create({ fromViewId: draft.id, temporaryAction: 'discard', cardIds: ['missing'] }, [a,b]), /existing cards/);
  assert.throws(() => views.activate('missing', { fromViewId: draft.id, temporaryAction: 'discard' }, [a,b]), /not found/);
  assert.throws(() => views.create({ fromViewId: original, temporaryAction: 'discard' }, [a,b]), /Active view changed/);
  assert.throws(() => views.activate(original, { fromViewId: draft.id, temporaryAction: 'save', saveName: '原有 Card box' }, [a,b]), /already exists/);
  assert.throws(() => views.create({ fromViewId: draft.id, temporaryAction: 'save', saveName: ' New ', name: 'New' }, [a,b]), /already exists/);
  assert.deepEqual(views.snapshot(), before);
  views.activate(original, { fromViewId: draft.id, temporaryAction: 'save', saveName: 'Cryptography' }, [a,b]);
  assert.equal(views.get(draft.id).saved, true);
  views.rename(draft.id, 'CRYPTOGRAPHY'); // Renaming the same view is allowed.
  assert.throws(() => views.rename(original, 'cryptography'), /already exists/);
});

test('view names, validation and deletion retain cards and always provide an active view', () => {
  const views = new CardViews(null, [a,b]);
  const original = views.active.id;
  const draft = views.create({ fromViewId: original, name: 'Crypto', cardIds: [a.id] }, [a,b]);
  views.save(draft.id);
  assert.throws(() => views.rename(original, 'ＣＲＹＰＴＯ'), /already exists/);
  views.rename(draft.id, 'CRYPTO');
  assert.throws(() => views.rename(draft.id, ''), /1–120/);
  assert.throws(() => views.remove(draft.id, {}, [a,b]), /confirm/);
  views.remove(draft.id, { confirm: true, fromViewId: draft.id }, [a,b]);
  assert.equal(views.active.id, original);
  views.remove(original, { confirm: true, fromViewId: original }, [a,b]);
  assert.equal(views.active.system, 'unfiled'); assert.equal(views.active.placements.size, 2);
  assert.throws(() => views.remove(views.active.id, { confirm: true, fromViewId: views.active.id }, [a,b]), /cannot be deleted/);
  const state = views.snapshot();
  assert.equal(validateViewState(state), state);
  assert.throws(() => validateViewState({ ...state, activeViewId: 'missing' }));
  assert.throws(() => validateViewState({ ...state, views: [{ ...state.views[0], viewport: { x: 0, y: 0, zoom: 9 } }] }));
});

test('view API migration, search, universal new-card membership, persistence, reset and deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-views-test-'));
  const stateFile = join(directory, 'canvas.json'), cardsFile = join(directory, 'cards.sqlite');
  const options = { port: 0, publicOrigin: null, stateFile, cardsFile, sessionsRoot: join(directory, 'sessions'), spawnAgent() { throw Error('Never spawn Pi'); } };
  let app = createApp(options);
  const request = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    await app.listen();
    const first = (await request('/cards', 'POST', { content: 'DH 密鑰交換', tags: ['crypto'] })).data;
    const second = (await request('/cards', 'POST', { content: 'Other topic', place: false })).data;
    await request('/card-box/placements/' + first.id, 'PATCH', { x: -600, y: 940, width: 500 });
    await app.close();
    const legacy = JSON.parse(await readFile(stateFile, 'utf8'));
    legacy.version = 2; legacy.cardBox = { placements: legacy.cardBox.placements };
    await writeFile(stateFile, JSON.stringify(legacy));
    app = createApp(options); await app.listen();
    const original = app.snapshot().cardBox.activeViewId;
    assert.equal(app.snapshot().cardBox.views[0].name, '原有 Card box');
    assert.equal(app.snapshot().cardBox.placements.find(p => p.id === first.id).x, -600);
    const search = await request('/cards?q=crypto%20Other&limit=1&offset=1');
    assert.equal(search.data.total, 2); assert.equal(search.data.cards.length, 1);
    assert.equal((await request('/cards?q=密鑰')).data.total, 1);
    assert.equal((await request('/cards?q=' + first.id)).data.total, 1);
    assert.equal((await request('/cards?q=a&limit=101')).status, 400);
    const created = await request('/card-box/views', 'POST', { name: 'Cryptography', cardIds: [first.id], fromViewId: original });
    assert.equal(created.status, 201);
    const draft = created.data.activeViewId;
    assert.equal((await request(`/card-box/views/${original}/activate`, 'POST', { fromViewId: draft })).status, 409);
    assert.equal((await request(`/card-box/views/${draft}/cards/missing`, 'POST', {})).status, 404);
    assert.equal((await request(`/card-box/views/${draft}/cards/${first.id}`, 'PATCH', { x: 800, height: 1 })).status, 400);
    assert.equal(app.snapshot().cardBox.placements[0].x, 540);
    await request(`/card-box/views/${draft}/cards/${first.id}`, 'PATCH', { x: 800, width: 650 });
    await request(`/card-box/views/${draft}/viewport`, 'PATCH', { x: 120, y: -90, zoom: 0.7 });
    const third = (await request('/cards', 'POST', { content: 'New from general API', place: false })).data;
    assert.ok(app.snapshot().cardBox.placements.some(p => p.id === third.id));
    assert.ok(!app.snapshot().cardBox.views.find(v => v.id === original).placements.some(p => p.id === third.id));
    const epoch = app.snapshot().cardBox.epoch;
    await app.close(); app = createApp(options); await app.listen();
    assert.notEqual(app.snapshot().cardBox.epoch, epoch);
    assert.equal(app.snapshot().cardBox.activeViewId, draft);
    assert.equal(app.snapshot().cardBox.views.find(v => v.id === draft).saved, false);
    assert.deepEqual(app.snapshot().cardBox.views.find(v => v.id === draft).viewport, { x: 120, y: -90, zoom: 0.7 });
    const savedFile = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(savedFile.cardBox.epoch, undefined);
    assert.equal(savedFile.version, 4); assert.equal(validateCanvas(savedFile), savedFile);
    await request(`/card-box/views/${draft}/save`, 'POST', { name: 'Cryptography' });
    await request(`/card-box/views/${original}/activate`, 'POST', { fromViewId: draft });
    assert.equal(app.snapshot().cardBox.placements.find(p => p.id === first.id).x, -600);
    await request(`/card-box/views/${original}/cards/${first.id}`, 'DELETE', {});
    assert.equal((await request('/cards/' + first.id)).status, 200);
    await request(`/card-box/views/${original}/cards/${first.id}`, 'POST', {});
    await request('/cards/' + first.id, 'DELETE', { confirm: true });
    assert.ok(app.snapshot().cardBox.views.every(v => !v.placements.some(p => p.id === first.id)));
    await request('/canvas/reset', 'POST', { confirm: true });
    assert.equal(app.snapshot().cardBox.views.length, 3);
    await request(`/card-box/views/${draft}`, 'DELETE', { confirm: true });
    assert.equal((await request('/cards/' + third.id)).status, 200);
    assert.equal((await request('/cards/' + second.id)).status, 200);
    assert.equal(app.snapshot().agents.length, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
