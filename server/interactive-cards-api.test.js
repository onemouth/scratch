import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzZAAAAAElFTkSuQmCC', 'base64');

async function request(app, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); return { status: response.status, value };
}

test('interactive card API, title search, placement and local asset lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interactive-card-'));
  const mediaRoot = join(dir, 'media');
  await mkdir(join(mediaRoot, 'images', 'charts'), { recursive: true });
  await mkdir(join(mediaRoot, 'audio', 'charts'), { recursive: true });
  await writeFile(join(mediaRoot, 'images', 'charts', 'dot.png'), png);
  await writeFile(join(mediaRoot, 'audio', 'charts', 'dot.png'), png);
  await writeFile(join(dir, 'outside.png'), png);
  await symlink(join(dir, 'outside.png'), join(mediaRoot, 'images', 'escape.png')); 
  const app = createApp({ port: 0, stateFile: join(dir, 'canvas.json'), cardsFile: join(dir, 'cards.sqlite'), interactiveMediaRoot: mediaRoot, spawnAgent() { throw Error('Never spawn'); } });
  try {
    await app.listen();
    const created = await request(app, '/cards', 'POST', { type: 'interactive', title: 'Orbit display', html: '<canvas></canvas>', css: 'canvas{width:100%}', javascript: 'console.log("go")', tags: ['visual'] });
    assert.equal(created.status, 201);
    assert.equal(created.value.type, 'interactive');
    assert.equal(app.snapshot().cards[0].interactive.html, undefined);
    assert.equal((await request(app, `/cards/${created.value.id}`)).value.interactive.html, '<canvas></canvas>');
    assert.equal(app.snapshot().cardPlacements[0].width, 560);
    assert.equal((await request(app, `/card-placements/${created.value.id}`, 'PATCH', { width: 300 })).status, 400);
    assert.equal((await request(app, '/cards?q=orbit&limit=24&offset=0')).value.total, 1);
    assert.equal((await request(app, '/cards?q=console&limit=24&offset=0')).value.total, 0);
    const imported = await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'image', source: 'charts/dot.png', name: 'dot' });
    assert.equal(imported.status, 201);
    assert.equal(imported.value.assets[0].name, 'dot');
    assert.equal(imported.value.interactive.revision, 1);
    assert.equal((await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'image', source: '../outside.png', name: 'traversal' })).status, 400);
    assert.equal((await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'image', source: 'escape.png', name: 'escape' })).status, 400);
    assert.equal((await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'audio', source: 'charts/dot.png', name: 'wrong' })).status, 415);
    assert.equal((await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'image', source: 'charts/dot.png', name: 'dot' })).status, 409);
    const file = await fetch(`http://127.0.0.1:${app.server.address().port}${imported.value.assets[0].url}`);
    assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('access-control-allow-origin'), '*');
    const ranged = await fetch(`http://127.0.0.1:${app.server.address().port}${imported.value.assets[0].url}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 4);
    assert.equal((await request(app, `/cards/${created.value.id}/interactive-assets/dot`, 'DELETE', {})).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}${imported.value.assets[0].url}`)).status, 404);
    assert.equal((await request(app, `/cards/${created.value.id}`, 'PATCH', { title: 'Updated', tags: ['new'] })).value.title, 'Updated');
    const finalAsset = (await request(app, `/cards/${created.value.id}/interactive-assets/import`, 'POST', { kind: 'image', source: 'charts/dot.png', name: 'final' })).value.assets[0];
    assert.equal((await request(app, `/cards/${created.value.id}`, 'DELETE', { confirm: true })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}${finalAsset.url}`)).status, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
