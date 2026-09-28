import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedAgents } from './agent-notifications.js';

test('only live working-to-idle transitions notify', () => {
  const idle = { id: 'a', name: 'a', status: 'running', activity: 'idle' };
  assert.deepEqual(completedAgents(null, [idle]), []);
  assert.deepEqual(completedAgents(new Map([['a', 'unknown']]), [idle]), []);
  assert.deepEqual(completedAgents(new Map([['a', 'idle']]), [idle]), []);
  assert.deepEqual(completedAgents(new Map([['a', 'working']]), [{ ...idle, status: 'stopped' }]), []);
  assert.deepEqual(completedAgents(new Map([['a', 'working']]), [idle]), [idle]);
});
