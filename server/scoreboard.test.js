import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from './index.js';
import { openCanvasMemory } from '../shared/canvas-memory.js';
import { reportTelemetry } from '../scripts/tests/telemetry-fixture.js';

// Actual POSIX telemetry and snapshot, isolated fake PTYs; no models/live data.
test('scoreboard SHM/browser projection orders reports and state changes, retains idle progress, clears replacement processes and fences old reports', async () => {
  const children = [];
  const app = createApp({ port: 0, spawnAgent(_bin, _args, options) {
    const child = new EventEmitter();
    Object.assign(child, { options, onData: fn => child.on('data', fn), onExit: fn => child.on('exit', fn), write() {}, resize() {}, kill() { this.emit('exit', { exitCode: 0 }); } });
    children.push(child); return child;
  } });
  let reader;
  try {
    await app.listen();
    const base = `http://127.0.0.1:${app.server.address().port}/api`;
    const api = async (path, body = {}) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    const a = await api('/agents', { name: 'A', workdir: process.cwd() });
    const b = await api('/agents', { name: 'B', workdir: process.cwd() });
    await api('/card-box/agent');
    reader = openCanvasMemory(app.sharedMemory.name, app.sharedMemory.epoch);
    const rows = () => app.snapshot().scoreboard;
    assert.deepEqual(rows().map(row => row.id), [b.id, a.id]);
    assert.equal(rows()[0].progress, '');
    await reportTelemetry(children[0], 'progress', { text: 'Latest <literal> 🧋' });
    assert.equal(rows()[0].id, a.id);
    const first = rows()[0].updatedAt;
    await reportTelemetry(children[0], 'activity', { state: 'idle' });
    assert.equal(rows()[0].progress, 'Latest <literal> 🧋');
    assert.equal(rows()[0].status, 'idle'); assert.ok(rows()[0].updatedAt > first);
    const idle = rows()[0].updatedAt;
    await reportTelemetry(children[0], 'activity', { state: 'idle' });
    assert.equal(rows()[0].updatedAt, idle, 'unchanged activity does not reorder');
    await reportTelemetry(children[0], 'session', { sessionFile: '/fixture/session.jsonl', sessionId: 'fixture' });
    assert.equal(rows()[0].updatedAt, idle, 'session handoffs do not reorder or clear');
    await reportTelemetry(children[1], 'activity', { state: 'working' });
    assert.equal(rows()[0].id, b.id);
    await reportTelemetry(children[0], 'progress', { text: 'Latest <literal> 🧋' });
    assert.equal(rows()[0].id, a.id, 'explicit repeated progress report is a fresh update');
    const stable = rows(); app.runtime.notify();
    assert.deepEqual(rows(), stable, 'unrelated publication does not reorder');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(reader.read().scoreboard, rows(), 'same authoritative projection in SHM and browser state');
    const oldGeneration = rows()[0].generation;
    await api(`/agents/${a.id}/stop`);
    assert.deepEqual(rows().map(row => row.id), [b.id]);
    await api(`/agents/${a.id}/resume`);
    assert.equal(rows()[0].id, a.id); assert.equal(rows()[0].progress, '');
    assert.notEqual(rows()[0].generation, oldGeneration);
    assert.throws(() => app.runtime.applyTelemetry(a.id, oldGeneration, { seq: 999, kind: 'progress', data: { text: 'Stale' } }), { code: 'TELEMETRY_GENERATION' });
    await reportTelemetry(children.at(-1), 'activity', { state: 'idle' });
    assert.equal(rows()[0].progress, '');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(reader.read().scoreboard, rows());
  } finally { reader?.close(); await app.close(); }
});
