import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';
import { CardStore } from './card-store.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTXQAAAAASUVORK5CYII=', 'base64');
function wav() {
  const data = Buffer.alloc(44 + 32000);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(32000, 40); return data;
}
test('media uploads, safe streaming/ranges, CAS replacement, unlinking, restart and retained files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-media-'));
  const stateFile = join(dir, 'canvas.json'), cardsFile = join(dir, 'cards.sqlite');
  let app = createApp({ port: 0, stateFile, cardsFile });
  const req = (path, options) => fetch('http://127.0.0.1:' + app.server.address().port + '/api' + path, options);
  const json = (path, method, body) => req(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = (id, kind, bytes, name, expected) => req('/cards/' + id + '/media/' + kind, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...(expected ? { 'If-Match': expected } : {}) }, body: bytes });
  try {
    await app.listen();
    const card = await (await json('/cards', 'POST', { content: 'Original', tags: ['keep'] })).json();
    const id = card.id;
    assert.equal(card.image, null); assert.equal(card.audio, null);
    let response = await upload(id, 'image', png, '中文 image.png');
    assert.equal(response.status, 200);
    const image = (await response.json()).image;
    assert.equal(image.name, '中文 image.png');
    assert.equal(image.mime, 'image/png'); assert.equal(image.size, png.length);
    assert.equal('filename' in image, false);
    assert.equal(app.snapshot().cards[0].image.id, image.id);
    assert.equal((await upload(id, 'image', png, 'second.png')).status, 409);
    assert.equal((await upload(id, 'image', png, 'second.png', '00000000-0000-0000-0000-000000000000')).status, 409);
    response = await req(image.url.slice(4));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const etag = response.headers.get('etag');
    assert.equal((await req(image.url.slice(4), { headers: { 'If-None-Match': etag } })).status, 304);
    response = await req(image.url.slice(4), { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/' + png.length);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(2, 6));
    response = await req(image.url.slice(4), { method: 'HEAD' });
    assert.equal(response.headers.get('content-length'), String(png.length));
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    response = await req(image.url.slice(4), { headers: { Range: 'bytes=-4' } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(-4));
    assert.equal((await req(image.url.slice(4), { headers: { Range: 'bytes=999999-' } })).status, 416);
    assert.equal((await req(image.url.slice(4), { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
    response = await upload(id, 'audio', wav(), 'voice.wav');
    assert.equal(response.status, 200);
    const audio = (await response.json()).audio;
    assert.equal(audio.mime, 'audio/wav');
    assert.equal((await upload(id, 'audio', png, 'fake.wav', audio.id)).status, 415);
    assert.equal((await upload(id, 'image', Buffer.from('<svg></svg>'), 'bad.svg', image.id)).status, 415);
    assert.equal((await upload(id, 'image', Buffer.alloc(0), 'empty.png', image.id)).status, 400);
    assert.equal((await upload(id, 'image', png, '../bad.png', image.id)).status, 400);
    assert.equal((await upload(id, 'image', Buffer.alloc(10 * 1024 * 1024 + 1), 'huge.png', image.id)).status, 413);
    response = await upload(id, 'image', png, 'replacement.png', image.id);
    assert.equal(response.status, 200);
    const replacement = (await response.json()).image;
    assert.notEqual(replacement.id, image.id);
    assert.equal((await req(image.url.slice(4))).status, 200); // Unlinked old bytes retained.
    const stale = await json('/cards/' + id + '/media/image', 'DELETE', { attachmentId: image.id });
    assert.equal(stale.status, 409);
    assert.equal((await json('/cards/' + id, 'PATCH', { image: null })).status, 400);
    assert.equal((await json('/cards/' + id, 'PATCH', { content: 'New text' })).status, 200);
    let current = await (await req('/cards/' + id)).json();
    assert.equal(current.image.id, replacement.id); assert.equal(current.audio.id, audio.id);
    assert.deepEqual(current.tags, ['keep']);
    await app.close();
    app = createApp({ port: 0, stateFile, cardsFile }); await app.listen();
    current = await (await req('/cards/' + id)).json();
    assert.equal(current.image.id, replacement.id); assert.equal(current.audio.id, audio.id);
    assert.equal((await req(audio.url.slice(4), { headers: { Range: 'bytes=44-100' } })).status, 206);
    assert.equal((await json('/cards/' + id + '/media/image', 'DELETE', { attachmentId: replacement.id })).status, 200);
    assert.equal((await req(replacement.url.slice(4))).status, 200);
    assert.equal((await (await req('/cards/' + id)).json()).image, null);
    await json('/canvas/reset', 'POST', { confirm: true });
    assert.equal((await (await req('/cards/' + id)).json()).audio.id, audio.id);
    await json('/cards/' + id, 'DELETE', { confirm: true });
    assert.equal((await req(audio.url.slice(4))).status, 200);
    assert.equal((await req(image.url.slice(4))).status, 200);
    assert.equal((await req(replacement.url.slice(4))).status, 200);
    assert.equal((await upload(id, 'image', png, 'deleted.png')).status, 404);
    const images = await readdir(join(dir, 'images')), audios = await readdir(join(dir, 'audios'));
    assert.equal(images.length, 2); assert.equal(audios.length, 1);
    assert.ok(![...images, ...audios].some(name => name.endsWith('.upload')));
    assert.deepEqual(await readFile(join(dir, 'images', image.id + '.png')), png);
    await unlink(join(dir, 'audios', audio.id + '.wav'));
    assert.equal((await req(audio.url.slice(4))).status, 404);
    assert.equal((await req('/card-files/not-a-file')).status, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SQLite schema 3 migration preserves card contents, links, IDs and sequences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'card-media-migration-'));
  const file = join(dir, 'cards.sqlite');
  let store = new CardStore(file, () => new Date(2026, 9, 3));
  try {
    const a = store.create({ content: 'Original', tags: ['tag'] }), b = store.create({ links: [a.id] });
    store.db.exec('DROP TABLE card_media; DROP TABLE card_files; PRAGMA user_version=3;');
    store.close(); store = new CardStore(file, () => new Date(2026, 9, 3));
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(store.get(a.id).content, 'Original');
    assert.deepEqual(store.get(a.id).tags, ['tag']); assert.deepEqual(store.get(a.id).links, [b.id]);
    assert.equal(store.get(a.id).image, null); assert.equal(store.get(a.id).audio, null);
    assert.equal(store.create().id, '2026-10-03-0003');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
