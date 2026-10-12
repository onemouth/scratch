import { test } from 'node:test';
import assert from 'node:assert/strict';
import sessionTracker, { assistantPreview } from './pi-session-tracker.js';

test('tracker reports each session switch without sending a prompt', async () => {
  const keys = ['AGENT_CANVAS_URL', 'AGENT_CANVAS_ID', 'AGENT_CANVAS_RUN'];
  const original = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const reports = [];
  try {
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
      { runToken: 'run', sessionFile: '/sessions/one.jsonl', sessionId: 'one' },
      { runToken: 'run', sessionFile: '/sessions/two.jsonl', sessionId: 'two' },
    ]);
    assert.deepEqual(reports.filter(report => report.url.endsWith('/activity')).map(report => report.body.state), ['idle', 'idle', 'working', 'idle']);
    assert.deepEqual(reports.filter(report => report.url.endsWith('/activity')).map(report => report.body.seq), [1, 2, 3, 4]);
    assert.equal(reports.filter(report => report.url.endsWith('/activity')).at(-1).body.summary, 'Finished Updated the terminal notification.');
    assert.equal(reports[0].url, 'http://127.0.0.1:1234/api/agents/node/activity');
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
  }
});

test('assistant preview is plain, Unicode-safe and bounded', () => {
  assert.equal(assistantPreview({ role: 'user', content: 'ignored' }), '');
  assert.equal(assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '**Done**' }] }), 'Done');
  const preview = assistantPreview({ role: 'assistant', content: [{ type: 'text', text: '🙂'.repeat(121) }] });
  assert.equal(Array.from(preview).length, 120);
  assert.match(preview, /…$/);
});
