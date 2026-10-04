import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from './index.js';
import { parsePublicOrigin } from './public-origin.js';

test('public origin is opt-in, a single exact HTTPS origin, and validated before startup', () => {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(''), null);
  assert.equal(parsePublicOrigin('https://canvas.example.ts.net/'), 'https://canvas.example.ts.net');
  assert.equal(parsePublicOrigin('https://CANVAS.example.ts.net:443'), 'https://canvas.example.ts.net');
  for (const value of ['http://canvas.example.ts.net', '*', 'https://*.ts.net', 'https://user:secret@host', 'https://@host', 'https://host/path', 'https://host/../', 'https://host?x=1', 'https://host/#x', ' https://host', 'https://host\n', 'https://host\\path', 123]) {
    assert.throws(() => createApp({ publicOrigin: value }), /AGENT_CANVAS_PUBLIC_ORIGIN/);
  }
});
test('trusted HTTPS API/WS origin works; untrusted origins fail and agents remain on loopback', async () => {
  const origin = 'https://canvas.example.ts.net';
  let child;
  const app = createApp({ port: 0, publicOrigin: origin, spawnAgent: (_bin, _args, options) => {
    child = new EventEmitter();
    Object.assign(child, { options, inputs: [], onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write: data => child.inputs.push(data), resize() {}, kill() { child.emit('exit', { exitCode: 0 }); } });
    return child;
  } });
  await app.listen();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const req = (path, browserOrigin, method = 'GET', body) => fetch(base + path, { method, headers: { ...(browserOrigin ? { Origin: browserOrigin } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let ws;
  try {
    assert.equal(app.server.address().address, '127.0.0.1');
    assert.equal((await req('/api/state', origin)).status, 200);
    assert.equal((await req('/api/state')).status, 200);
    assert.equal((await req('/api/state', base)).status, 200);
    assert.equal((await req('/api/state', 'http://127.0.0.1:5173')).status, 200);
    for (const denied of ['https://other.example.ts.net', origin + '.evil.example', origin + ':444', 'http://canvas.example.ts.net', 'null']) {
      assert.equal((await req('/api/state', denied)).status, 403);
      assert.equal((await req('/api/cards', denied, 'POST', { content: 'Must not save' })).status, 403);
    }
    assert.equal(app.snapshot().cards.length, 0);
    const guide = await req('/api/docs?origin=' + encodeURIComponent(origin), origin);
    assert.ok((await guide.text()).includes('curl -fsS "' + origin + '/api/state"'));
    const spoofed = await req('/api/docs?origin=https%3A%2F%2Fevil.example', origin);
    assert.ok((await spoofed.text()).includes('curl -fsS "' + base + '/api/state"'));
    const created = await req('/api/agents', origin, 'POST', { name: 'proxy test', workdir: process.cwd() });
    assert.equal(created.status, 201);
    const agent = await created.json();
    assert.equal(child.options.env.AGENT_CANVAS_URL, base);
    const url = base.replace('http:', 'ws:') + '/api/terminal/' + agent.id;
    ws = new WebSocket(url, { origin });
    await once(ws, 'open');
    const message = once(ws, 'message'); child.emit('data', 'Tailnet terminal'); assert.equal((await message)[0].toString(), 'Tailnet terminal');
    ws.send(JSON.stringify({ type: 'input', data: 'hello' }));
    for (let i = 0; i < 50 && !child.inputs.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(child.inputs, ['hello']);
    const denied = new WebSocket(url, { origin: 'https://other.example.ts.net' });
    const failed = new Promise(resolve => denied.once('error', resolve));
    assert.ok(await failed);
    denied.terminate();
  } finally { ws?.terminate(); await app.close(); }
});
test('public browser origins remain denied unless explicitly configured', async () => {
  const app = createApp({ port: 0, publicOrigin: null });
  try {
    await app.listen();
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/state', { headers: { Origin: 'https://canvas.example.ts.net' } });
    assert.equal(response.status, 403);
  } finally { await app.close(); }
});
