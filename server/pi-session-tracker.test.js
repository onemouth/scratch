import { test } from 'node:test';
import assert from 'node:assert/strict';
import sessionTracker, { assistantPreview } from './pi-session-tracker.js';

test('standalone Pi without Canvas identity does not register tracker resources', () => {
  const previous = process.env.AGENT_CANVAS_ID;
  try {
    delete process.env.AGENT_CANVAS_ID;
    sessionTracker({ on() { assert.fail('No Canvas hooks'); }, registerTool() { assert.fail('No Canvas tool'); } });
  } finally { if (previous !== undefined) process.env.AGENT_CANVAS_ID = previous; }
});

for (const config of [undefined, '{']) test(`missing/broken SHM config never activates removed HTTP mode (${config ?? 'missing'})`, async () => {
  const saved = { ...process.env }, originalFetch = globalThis.fetch, notices = [], statuses = [], hooks = new Map(), tools = [];
  let httpCalls = 0;
  try {
    Object.assign(process.env, { AGENT_CANVAS_URL: 'http://127.0.0.1:1234', AGENT_CANVAS_ID: 'node', AGENT_CANVAS_RUN: 'obsolete', AGENT_CANVAS_TELEMETRY_TRANSPORT: 'http', AGENT_CANVAS_SHARED_MEMORY: '0' });
    if (config === undefined) delete process.env.AGENT_CANVAS_SHM_TELEMETRY;
    else process.env.AGENT_CANVAS_SHM_TELEMETRY = config;
    globalThis.fetch = () => { httpCalls++; throw new Error('HTTP forbidden'); };
    sessionTracker({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.push(tool) });
    assert.equal(tools[0].name, 'canvas_set_progress');
    await hooks.get('session_start')({}, { mode: 'tui', hasUI: true, ui: { notify: value => notices.push(value), setStatus: (...args) => statuses.push(args) } });
    assert.equal(httpCalls, 0); assert.equal(notices.length, 0);
    assert.match(statuses.at(-1)[1], /Canvas error: telemetry TELEMETRY_CONFIG/);
    assert.equal(process[Symbol.for('agent-canvas.telemetry.process.v1')], undefined);
  } finally { hooks.get('session_shutdown')?.({ reason: 'quit' }); globalThis.fetch = originalFetch; process.env = saved; }
});

test('assistant preview is plain, Unicode-safe and bounded', () => {
  assert.equal(assistantPreview({ role: 'user', content: 'ignored' }), '');
  assert.equal(assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '**Done**' }] }), 'Done');
  const preview = assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '🙂'.repeat(121) }] });
  assert.equal(Array.from(preview).length, 120);
  assert.match(preview, /…$/);
});
