import { test } from 'node:test';
import assert from 'node:assert/strict';
import { includeCreatedAgent } from './agent-state.js';

test('a successful launch appears immediately even before an SSE update', () => {
  const existing = { id: 'existing', status: 'running' };
  const state = { agents: [existing], edges: [], cards: [], cardBox: { placements: [] } };
  const created = { id: 'new', workspace: 'agents', status: 'running' };
  const next = includeCreatedAgent(state, created);
  assert.deepEqual(next.agents, [existing, created]);
  assert.deepEqual(state.agents, [existing]);
  for (const key of ['edges', 'cards', 'cardBox']) assert.equal(next[key], state[key]);
  assert.equal(includeCreatedAgent(next, created), next);
});

test('a newer SSE version is not overwritten by a delayed creation response', () => {
  const live = { id: 'new', status: 'stopped', activity: 'idle', output: 'Latest output' };
  const state = { agents: [live], edges: [] };
  assert.equal(includeCreatedAgent(state, { id: 'new', status: 'running', output: '' }), state);
  assert.equal(state.agents[0], live);
});

test('the fixed Card box agent also appears without waiting for SSE', () => {
  const created = { id: 'box', workspace: 'card-box', status: 'running' };
  assert.deepEqual(includeCreatedAgent({ agents: [], edges: [] }, created).agents, [created]);
});
