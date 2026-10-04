import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devServerConfig } from '../vite.config.js';

test('dev stays loopback-only on fixed Vite port, explicitly trusts HTTPS host, and proxies API/WS', () => {
  const local = devServerConfig({});
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 5173);
  assert.equal(local.strictPort, true);
  assert.deepEqual(local.allowedHosts, []);
  assert.deepEqual(local.proxy['/api'], { target: 'http://127.0.0.1:3001', ws: true });
  const remote = devServerConfig({ AGENT_CANVAS_PUBLIC_ORIGIN: 'https://canvas.example.ts.net', PORT: '3002' });
  assert.deepEqual(remote.allowedHosts, ['canvas.example.ts.net']);
  assert.equal(remote.proxy['/api'].target, 'http://127.0.0.1:3002');
  assert.equal(remote.hmr, undefined); // auto ws/wss URL detection supports both origins
  assert.throws(() => devServerConfig({ AGENT_CANVAS_PUBLIC_ORIGIN: 'https://*.ts.net' }));
  for (const PORT of ['0', '65536', '3001.5', 'abc']) assert.throws(() => devServerConfig({ PORT }), /PORT/);
});
