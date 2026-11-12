import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from './index.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); } throw Error('Terminal fixture timeout'); }

test('mobile terminal observes authoritative dimensions, requires opt-in and fences process replacement', async () => {
  const children = [], sockets = [];
  const app = createApp({ port: 0, spawnAgent(_bin, _args, options) {
    const child = new EventEmitter();
    Object.assign(child, { options, writes: [], resizes: [], onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write(data) { this.writes.push(data); }, resize(cols, rows) { this.resizes.push({ cols, rows }); }, kill() { this.emit('exit', { exitCode: 0 }); } });
    children.push(child); return child;
  } });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body) => {
    const res = await fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.ok, true); return res.json();
  };
  const connect = async path => {
    const ws = new WebSocket(base.replace('http', 'ws') + path), frames = [];
    sockets.push(ws); ws.on('message', (bytes, binary) => frames.push({ text: bytes.toString(), binary }));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, frames, send: message => ws.send(JSON.stringify(message)) };
  };
  try {
    const agent = await api('/agents', { name: 'Mobile fixture', workdir: process.cwd() });
    const generation = app.runtime.get(agent.id).processGeneration;
    const child = children[0]; child.emit('data', 'Output before attachment');
    const desktop = await connect(`/api/terminal/${agent.id}`);
    const path = `/api/terminal/${agent.id}?mobile=1&generation=${generation}`;
    const mobile = await connect(path);
    await wait(() => mobile.frames.length === 2);
    assert.deepEqual(JSON.parse(mobile.frames[0].text), { type: 'size', cols: 50, rows: 16 });
    assert.equal(mobile.frames[0].binary, true);
    assert.deepEqual(mobile.frames[1], { text: 'Output before attachment', binary: false });
    mobile.send({ type: 'input', data: 'ignored' });
    mobile.send({ type: 'resize', cols: 10, rows: 10 });
    await delay(30); assert.deepEqual(child.writes, []); assert.deepEqual(child.resizes, []);
    desktop.send({ type: 'resize', cols: 110, rows: 35 });
    await wait(() => mobile.frames.length === 3);
    assert.deepEqual(JSON.parse(mobile.frames[2].text), { type: 'size', cols: 110, rows: 35 });
    assert.deepEqual(child.resizes, [{ cols: 110, rows: 35 }]);
    assert.equal(desktop.frames.every(frame => !frame.binary), true, 'desktop remains ANSI-only');
    mobile.send({ type: 'input-mode', enabled: true }); mobile.send({ type: 'input', data: '中文\r' });
    await wait(() => child.writes.length === 1); assert.deepEqual(child.writes, ['中文\r']);
    mobile.send({ type: 'input-mode', enabled: false }); mobile.send({ type: 'input', data: 'ignored again' });
    const second = await connect(path);
    await wait(() => second.frames.length === 2);
    assert.deepEqual(JSON.parse(second.frames[0].text), { type: 'size', cols: 110, rows: 35 });
    second.send({ type: 'input', data: 'new socket starts read-only' });
    child.emit('data', '\r\nNew live output');
    await wait(() => second.frames.some(frame => frame.text === '\r\nNew live output'));
    await delay(20); assert.deepEqual(child.writes, ['中文\r']);
    let ended;
    mobile.ws.on('close', code => { ended = code; });
    await api(`/agents/${agent.id}/stop`, {}); await wait(() => ended === 4001);
    await api(`/agents/${agent.id}/resume`, {});
    assert.notEqual(app.runtime.get(agent.id).processGeneration, generation);
    const stale = new WebSocket(base.replace('http', 'ws') + path); sockets.push(stale);
    const rejected = await new Promise(resolve => { stale.once('error', () => resolve(true)); stale.once('open', () => resolve(false)); });
    assert.equal(rejected, true, 'old generations cannot attach to a new PTY');
    assert.deepEqual(children[1].writes, []);
    assert.deepEqual(children[1].resizes, []);
    desktop.send({ type: 'input', data: 'desktop unchanged' });
    await wait(() => children[1].writes.length === 1);
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); }
});
