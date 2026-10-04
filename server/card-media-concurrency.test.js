import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTXQAAAAASUVORK5CYII=', 'base64');
const poll = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for upload cleanup'); };

test('concurrent slot uploads have one winner; chunked oversize and disconnects clean staging files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'media-concurrent-'));
  const app = createApp({ port: 0, cardsFile: join(directory, 'cards.sqlite') });
  try {
    await app.listen();
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const card = await (await fetch(base + '/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const path = '/api/cards/' + card.id + '/media/image';
    const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'image.png' };
    const responses = await Promise.all([1, 2].map(() => fetch(base + path, { method: 'PUT', headers, body: png })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await responses.find(response => response.status === 200).json();
    assert.equal((await readdir(join(directory, 'images'))).length, 1);
    // Unknown content length is still bounded while streaming, not just by headers.
    const oversized = await fetch(base + path, { method: 'PUT', headers: { ...headers, 'If-Match': winner.image.id }, duplex: 'half', body: Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)]) });
    assert.equal(oversized.status, 413);
    assert.equal((await (await fetch(base + '/api/cards/' + card.id)).json()).image.id, winner.image.id);
    assert.equal((await readdir(join(directory, 'images'))).length, 1);
    const interrupted = http.request(base + path, { method: 'PUT', headers: { ...headers, 'If-Match': winner.image.id, 'Content-Length': png.length + 1000 } });
    interrupted.on('error', () => {});
    interrupted.write(png.subarray(0, 8));
    await poll(async () => (await readdir(join(directory, 'images'))).some(name => name.endsWith('.upload')));
    interrupted.destroy();
    await poll(async () => !(await readdir(join(directory, 'images'))).some(name => name.endsWith('.upload')));
    assert.equal((await readdir(join(directory, 'images'))).length, 1);
    assert.equal((await (await fetch(base + '/api/cards/' + card.id)).json()).image.id, winner.image.id);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
