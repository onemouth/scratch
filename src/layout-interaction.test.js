import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutInteraction } from './layout-interaction.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('gesture lease starts, renews and releases only after the final mutation completes', async () => {
  const calls = []; let heartbeat, canceled = false, commitDone;
  const finish = createLayoutInteraction({ owner: 'browser', request: async body => { calls.push(body.action); },
    schedule: fn => { heartbeat = fn; return 42; }, cancel: timer => { assert.equal(timer, 42); canceled = true; } });
  await tick(); heartbeat(); await tick();
  assert.deepEqual(calls, ['start', 'renew']);
  const complete = finish(() => new Promise(resolve => { calls.push('commit'); commitDone = resolve; }));
  await tick(); assert.equal(canceled, true); assert.deepEqual(calls, ['start', 'renew', 'commit']);
  heartbeat(); await tick(); assert.ok(!calls.includes('end'));
  commitDone(); await complete; assert.equal(calls.at(-1), 'end');
  assert.equal(finish(), complete, 'Cleanup cannot release or commit twice');
});

test('slow start/renew cannot arrive after lease release and failed commits still unlock', async () => {
  let releaseStart, heartbeat; const calls = [];
  const finish = createLayoutInteraction({ owner: 'browser', request: body => {
    calls.push(body.action);
    return body.action === 'start' ? new Promise(resolve => { releaseStart = resolve; }) : Promise.resolve();
  }, schedule: fn => { heartbeat = fn; }, cancel: () => {} });
  await tick(); heartbeat();
  const complete = finish(async () => { calls.push('commit'); throw new Error('Network failure'); });
  assert.deepEqual(calls, ['start']);
  releaseStart(); await assert.rejects(complete, /Network failure/);
  assert.deepEqual(calls, ['start', 'commit', 'end']);
});
