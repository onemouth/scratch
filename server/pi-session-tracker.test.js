import { test } from 'node:test';
import assert from 'node:assert/strict';
import sessionTracker, { assistantPreview } from './pi-session-tracker.js';

test('tracker reports each session switch without sending a prompt', async () => {
  const keys = ['AGENT_CANVAS_URL', 'AGENT_CANVAS_ID', 'AGENT_CANVAS_RUN', 'AGENT_CANVAS_TELEMETRY_TRANSPORT'];
  const original = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const reports = [];
  try {
    process.env.AGENT_CANVAS_TELEMETRY_TRANSPORT = 'http';
    process.env.AGENT_CANVAS_URL = 'http://127.0.0.1:1234';
    process.env.AGENT_CANVAS_ID = 'node';
    process.env.AGENT_CANVAS_RUN = 'run';
    globalThis.fetch = async (url, options) => { reports.push({ url, body: JSON.parse(options.body) }); return { ok: true }; };
    const handlers = new Map();
    sessionTracker({ on: (event, handler) => handlers.set(event, handler) });
    for (const id of ['one', 'two']) {
      await handlers.get('session_start')({}, { mode: 'tui', isIdle: () => true, sessionManager: { getSessionFile: () => `/sessions/${id}.jsonl`, getSessionId: () => id } });
    }
    handlers.get('agent_start')();
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '## Finished\nUpdated the [terminal](https://example.com) notification.' }] } });
    handlers.get('agent_settled')({}, { isIdle: () => true });
    assert.deepEqual(reports.filter(report => report.url.endsWith('/session')).map(report => report.body), [
      { runToken: 'run', sessionFile: '/sessions/one.jsonl', sessionId: 'one', seq: 2 },
      { runToken: 'run', sessionFile: '/sessions/two.jsonl', sessionId: 'two', seq: 4 },
    ]);
    assert.deepEqual(reports.filter(report => report.url.endsWith('/activity')).map(report => report.body.state), ['idle', 'idle', 'working', 'idle']);
    assert.deepEqual(reports.filter(report => report.url.endsWith('/activity')).map(report => report.body.seq), [1, 3, 5, 6]);
    assert.equal(reports.filter(report => report.url.endsWith('/activity')).at(-1).body.summary, 'Finished Updated the terminal notification.');
    assert.equal(reports[0].url, 'http://127.0.0.1:1234/api/agents/node/activity');
    handlers.get('session_shutdown')({ reason: 'quit' });
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
  }
});

test('explicit HTTP-only tracker keeps process sequences across runtime replacement without HTTP progress or retries', async () => {
  const saved = { ...process.env }, originalFetch = globalThis.fetch, key = Symbol.for('agent-canvas.telemetry.process.v1');
  const reports = [];
  const make = () => {
    const hooks = new Map();
    sessionTracker({ on: (name, fn) => hooks.set(name, fn) });
    return hooks;
  };
  const ctx = id => ({ mode: 'tui', isIdle: () => true, sessionManager: { getSessionFile: () => null, getSessionId: () => id } });
  try {
    Object.assign(process.env, { AGENT_CANVAS_URL: 'http://127.0.0.1:1234', AGENT_CANVAS_ID: 'node', AGENT_CANVAS_RUN: 'run', AGENT_CANVAS_TELEMETRY_TRANSPORT: 'http' });
    globalThis.fetch = async (_url, options) => { reports.push(JSON.parse(options.body)); return { ok: true }; };
    const old = make();
    await old.get('session_start')({}, ctx('old'));
    const broker = process[key];
    old.get('session_shutdown')({ reason: 'reload' });
    const next = make(); await next.get('session_start')({}, ctx('new'));
    old.get('session_shutdown')({ reason: 'quit' }); old.get('agent_start')();
    old.get('agent_settled')({}, { isIdle() { throw new Error('Must not use stale context'); } });
    assert.equal(process[key], broker);
    assert.deepEqual(reports.map(value => value.seq), [1, 2, 3, 4]);
    assert.equal(reports.at(-1).sessionId, 'new');
    next.get('session_shutdown')({ reason: 'quit' });
  } finally { process[key]?.close(); globalThis.fetch = originalFetch; process.env = saved; }
});

test('broken SHM configuration warns without ever switching to HTTP', async () => {
  const saved = { ...process.env }, originalFetch = globalThis.fetch, notices = [], hooks = new Map();
  let httpCalls = 0;
  try {
    Object.assign(process.env, { AGENT_CANVAS_URL: 'http://127.0.0.1:1234', AGENT_CANVAS_ID: 'node', AGENT_CANVAS_RUN: 'run', AGENT_CANVAS_TELEMETRY_TRANSPORT: 'shm', AGENT_CANVAS_SHM_TELEMETRY: '{' });
    globalThis.fetch = () => { httpCalls++; throw new Error('No HTTP fallback'); };
    sessionTracker({ on: (name, fn) => hooks.set(name, fn), registerTool() {} });
    await hooks.get('session_start')({}, { mode: 'tui', hasUI: true, ui: { notify: value => notices.push(value) } });
    assert.equal(httpCalls, 0); assert.equal(notices.length, 1);
    assert.match(notices[0], /No HTTP fallback/);
  } finally { globalThis.fetch = originalFetch; process.env = saved; }
});

test('assistant preview is plain, Unicode-safe and bounded', () => {
  assert.equal(assistantPreview({ role: 'user', content: 'ignored' }), '');
  assert.equal(assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '**Done**' }] }), 'Done');
  const preview = assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '🙂'.repeat(121) }] });
  assert.equal(Array.from(preview).length, 120);
  assert.match(preview, /…$/);
});
