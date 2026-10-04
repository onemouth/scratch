import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSetup, servePlan, setupOptions } from './tailscale-setup.js';
const status = { BackendState: 'Running', Self: { Online: true, DNSName: 'canvas.example.ts.net.' } };
const matching = (port = 5173) => ({ TCP: { 443: { HTTPS: true } }, Web: { 'canvas.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + port } } } } });

test('setup supports dev only, validates connectivity and DNS and fails closed on existing configurations', () => {
  assert.deepEqual(setupOptions([]), { apply: false, help: false });
  assert.throws(() => setupOptions(['--port', '3001']), /only npm run dev/);
  assert.throws(() => setupOptions(['--production']), /only npm run dev/);
  assert.throws(() => setupOptions(['--reset'], {}));
  assert.throws(() => servePlan({ BackendState: 'Stopped' }, {}), /not connected/);
  assert.throws(() => servePlan({ ...status, Self: { DNSName: 'evil.example' } }, {}), /hostname/);
  assert.equal(servePlan(status, null).state, 'empty');
  assert.equal(servePlan(status, { TCP: {}, Web: null }).state, 'empty');
  assert.equal(servePlan(status, matching()).state, 'matching');
  assert.equal(servePlan(status, matching(9000)).state, 'conflict');
  const funnel = matching(); funnel.AllowFunnel = { 'canvas.example.ts.net:443': true };
  assert.equal(servePlan(status, funnel).state, 'conflict');
  const foreground = matching(); foreground.Foreground = { 'session-id': matching() };
  assert.equal(servePlan(status, foreground).state, 'conflict');
  const extra = matching(); extra.Web['canvas.example.ts.net:443'].Handlers['/other'] = { Text: 'Keep this' };
  assert.equal(servePlan(status, extra).state, 'conflict');
  assert.equal(servePlan(status, { FutureUnknownField: false }).state, 'conflict');
  assert.throws(() => servePlan(status, []), /Unrecognized/);
});
test('dry run discovers bundled macOS CLI without applying any configuration or writing settings', () => {
  const calls = [], logs = [];
  const plan = runSetup([], { env: {}, read(bin, args, env) {
    calls.push({ bin, args, env });
    if (bin === 'tailscale') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return args[0] === 'status' ? status : {};
  }, apply() { assert.fail('Dry run must not apply'); }, log: line => logs.push(line) });
  assert.equal(plan.origin, 'https://canvas.example.ts.net');
  assert.equal(plan.state, 'empty');
  assert.ok(calls.every(call => call.env.TAILSCALE_BE_CLI === '1'));
  assert.ok(logs.some(line => line.includes('AGENT_CANVAS_PUBLIC_ORIGIN=')));
  assert.ok(logs.some(line => line.includes('Dry run only')));
  assert.ok(logs.some(line => line.includes('npm run dev')));
  assert.ok(!logs.some(line => /npm (start|run build)/.test(line)));
  assert.equal(plan.target, 'http://127.0.0.1:5173');
  assert.equal(servePlan(status, matching(3001)).state, 'conflict');
});
test('--apply invokes only tailnet HTTPS Serve, verifies results and rechecks before mutation', () => {
  let config = {}, applies = 0;
  const read = (_bin, args) => args[0] === 'status' ? status : config;
  runSetup(['--apply'], { env: { TAILSCALE_BIN: '/test/cli' }, read, log() {}, apply(bin, args) {
    assert.equal(bin, '/test/cli');
    assert.deepEqual(args, ['serve', '--bg', '--https=443', 'http://127.0.0.1:5173']);
    config = matching(); applies++;
  } });
  assert.equal(applies, 1);
  runSetup(['--apply'], { env: {}, read, log() {}, apply() { assert.fail('Matching config must be left alone'); } });
  config.AllowFunnel = { 'canvas.example.ts.net:443': true };
  assert.throws(() => runSetup(['--apply'], { env: {}, read, log() {}, apply() { assert.fail('Must not overwrite Funnel'); } }), /conflicts/);
  let reads = 0;
  assert.throws(() => runSetup(['--apply'], { env: {}, log() {}, read(_bin, args) {
    if (args[0] === 'status') return status;
    return ++reads === 1 ? {} : matching(9000);
  }, apply() { assert.fail('Must not overwrite a changed config'); } }), /configuration changed/);
});
test('setup refuses malformed CLI output and connection failures without alternate daemon fallback', () => {
  const error = new Error('Daemon unavailable');
  assert.throws(() => runSetup([], { env: {}, read() { throw error; }, log() {} }), /Daemon unavailable/);
  assert.throws(() => runSetup([], { env: {}, read(_bin, args) { return args[0] === 'status' ? status : false; }, log() {} }), /Unrecognized/);
  let applies = 0;
  assert.throws(() => runSetup(['--apply'], { env: {}, read(_bin, args) { return args[0] === 'status' ? status : {}; }, log() {}, apply() { applies++; } }), /verification failed/);
  assert.equal(applies, 1);
});
