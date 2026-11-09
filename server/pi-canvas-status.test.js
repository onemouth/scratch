import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindCanvasStatus, detachCanvasStatus, setCanvasStatus } from './pi-canvas-status.js';
import messagesExtension from './pi-canvas-messages.js';

const context = () => {
  const state = { statuses: [], notices: [], dead: false };
  state.ctx = { hasUI: true, ui: {
    setStatus: (...args) => { state.statuses.push(args); assert.equal(state.dead, false, 'Detached UI used'); },
    notify: (...args) => state.notices.push(args),
  } };
  return state;
};

test('both transports share one footer, recover independently and never print stale/recovery notices', () => {
  const current = context(), telemetry = Symbol(), messaging = Symbol();
  try {
    bindCanvasStatus('telemetry', telemetry, current.ctx);
    bindCanvasStatus('messaging', messaging, current.ctx);
    for (let i = 0; i < 20; i++) {
      setCanvasStatus('telemetry', telemetry, { code: 'SHM_STALE' });
      setCanvasStatus('messaging', messaging, { code: 'SHM_STALE' });
      assert.match(current.statuses.at(-1)[1], /Canvas paused: telemetry, messaging/);
      setCanvasStatus('telemetry', telemetry);
      assert.equal(current.statuses.at(-1)[1], 'Canvas paused: messaging');
      setCanvasStatus('messaging', messaging);
      assert.equal(current.statuses.at(-1)[1], undefined);
    }
    setCanvasStatus('telemetry', telemetry, { code: 'SHM_BUSY', fatal: true });
    assert.equal(current.statuses.at(-1)[1], 'Canvas error: telemetry SHM_BUSY');
    setCanvasStatus('telemetry', telemetry, { code: 'SHM_VERSION' });
    setCanvasStatus('messaging', messaging, { code: 'SHM_BUSY' });
    assert.equal(current.statuses.at(-1)[1], 'Canvas error: telemetry SHM_VERSION, messaging paused');
    setCanvasStatus('messaging', messaging);
    assert.equal(current.statuses.at(-1)[1], 'Canvas error: telemetry SHM_VERSION');
    assert.deepEqual(current.notices, []);
    assert.deepEqual([...new Set(current.statuses.map(([key]) => key))], ['canvas-transport']);
  } finally { detachCanvasStatus('telemetry', telemetry); detachCanvasStatus('messaging', messaging); }
});

test('replacement contexts ignore obsolete status updates and shutdowns across all session transitions', () => {
  for (const reason of ['reload', 'new', 'resume', 'fork']) {
    const old = context(), current = context(), owner = Symbol(reason), replacement = Symbol(reason);
    try {
      bindCanvasStatus('messaging', owner, old.ctx);
      setCanvasStatus('messaging', owner, { code: 'SHM_STALE' });
      detachCanvasStatus('messaging', owner);
      assert.equal(old.statuses.at(-1)[1], undefined);
      old.dead = true;
      const oldCount = old.statuses.length;
      setCanvasStatus('messaging', owner, { code: 'SHM_VERSION' });
      bindCanvasStatus('messaging', replacement, current.ctx);
      setCanvasStatus('messaging', replacement, { code: 'SHM_UNAVAILABLE' });
      const before = current.statuses.length;
      detachCanvasStatus('messaging', owner);
      setCanvasStatus('messaging', owner);
      assert.equal(current.statuses.length, before);
      assert.equal(current.statuses.at(-1)[1], 'Canvas paused: messaging');
      setCanvasStatus('messaging', replacement);
      assert.equal(current.statuses.at(-1)[1], undefined);
      assert.deepEqual(current.notices, []);
      assert.equal(old.statuses.length, oldCount);
    } finally { detachCanvasStatus('messaging', replacement); }
  }
});

test('headless, unsupported and throwing status UIs never affect transport handling or fall back to notify', () => {
  const owner = Symbol();
  try {
    for (const ctx of [
      { hasUI: false, ui: { setStatus() { assert.fail('Headless UI'); } } },
      { hasUI: true, ui: { notify() { assert.fail('No notification fallback'); } } },
      { hasUI: true, ui: { setStatus() { throw new Error('UI unavailable'); } } },
    ]) {
      bindCanvasStatus('telemetry', owner, ctx);
      setCanvasStatus('telemetry', owner, { code: 'SHM_STALE' });
      setCanvasStatus('telemetry', owner, { code: '\x1b[31m\nunsafe' });
      setCanvasStatus('telemetry', owner);
      detachCanvasStatus('telemetry', owner);
    }
  } finally { detachCanvasStatus('telemetry', owner); }
});

test('broken messaging configuration uses the footer and cleans up without a process broker', () => {
  const saved = { ...process.env }, hooks = new Map(), current = context();
  try {
    process.env.AGENT_CANVAS_SHM_MESSAGES = '{';
    messagesExtension({ on: (name, fn) => hooks.set(name, fn), registerTool() {} });
    hooks.get('session_start')({}, current.ctx);
    assert.equal(current.statuses.at(-1)[1], 'Canvas error: messaging MESSAGE_CONFIG');
    assert.deepEqual(current.notices, []);
  } finally {
    hooks.get('session_shutdown')?.({ reason: 'quit' });
    assert.equal(current.statuses.at(-1)[1], undefined);
    process.env = saved;
  }
});
