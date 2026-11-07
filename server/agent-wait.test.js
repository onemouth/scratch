import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAgent } from './agent-wait.js';

function fixture(activity = 'unknown') {
  let agent = { id: 'a', status: 'running', activity }, run = {}, closing = false;
  const listeners = new Set(), controller = new AbortController();
  return {
    listeners, controller,
    context: { getAgent: () => agent && { ...agent }, getRun: () => run, isClosing: () => closing,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, signal: controller.signal },
    update(next) { agent = next === null ? null : { ...agent, ...next }; for (const fn of listeners) fn(); },
    replace() { run = {}; for (const fn of listeners) fn(); },
    close() { closing = true; for (const fn of listeners) fn(); },
  };
}
test('wait removal returns detached last metadata and releases its observer', async () => {
  const f = fixture('working'), pending = waitForAgent({ id: 'a' }, f.context);
  assert.equal(f.listeners.size, 1); f.update(null);
  assert.deepEqual(await pending, { id: 'a', reason: 'removed', status: 'running', activity: 'working' });
  assert.equal(f.listeners.size, 0);
});
test('wait pins its process and never follows a replacement or assumes unknown is idle', async () => {
  const f = fixture(), pending = waitForAgent({ id: 'a' }, f.context);
  f.replace(); assert.equal((await pending).reason, 'stopped'); assert.equal(f.listeners.size, 0);
  assert.equal((await waitForAgent({ id: 'a', timeoutMs: 5 }, f.context)).reason, 'timeout');
  assert.equal(f.listeners.size, 0);
});
test('wait cancellation and shutdown release timers/listeners without changing the target', async () => {
  const f = fixture(), canceled = waitForAgent({ id: 'a' }, f.context);
  f.controller.abort(); await assert.rejects(canceled, { status: 499 }); assert.equal(f.listeners.size, 0);
  const pending = waitForAgent({ id: 'a' }, { ...f.context, signal: undefined });
  f.close(); await assert.rejects(pending, { status: 503 }); assert.equal(f.listeners.size, 0);
});
test('already idle/stopped is immediate; invalid/missing targets do not subscribe', async () => {
  const f = fixture('idle');
  assert.equal((await waitForAgent({ id: 'a' }, f.context)).reason, 'idle');
  f.update({ status: 'stopped' });
  assert.equal((await waitForAgent({ id: 'a' }, f.context)).reason, 'stopped');
  f.update(null);
  assert.throws(() => waitForAgent({ id: 'a' }, f.context), { status: 404 });
  assert.throws(() => waitForAgent({ id: 'a', timeoutMs: Infinity }, f.context), { status: 400 });
  assert.equal(f.listeners.size, 0);
});
