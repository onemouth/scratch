import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreboardRows } from './scoreboard.js';

test('scoreboard filters workspace/process state, projects safe fields and sorts newest first with deterministic ties', () => {
  const base = { status: 'running', activity: 'idle', note: '', processGeneration: 'generation' };
  const agents = [
    { ...base, id: 'b', name: 'B', scoreboardUpdatedAt: 10, task: 'PRIVATE', output: 'PRIVATE' },
    { ...base, id: 'a', name: 'A', scoreboardUpdatedAt: 10 },
    { ...base, id: 'new', name: 'New', activity: 'working', note: '<literal>\nfull progress', scoreboardUpdatedAt: 20 },
    { ...base, id: 'box', workspace: 'card-box', scoreboardUpdatedAt: 100 },
    { ...base, id: 'stop', status: 'stopped' }, { ...base, id: 'stopping', status: 'stopping' },
    { ...base, id: 'unknown', activity: 'unknown', note: undefined },
  ];
  const rows = scoreboardRows(agents);
  assert.deepEqual(rows.map(row => row.id), ['new', 'a', 'b', 'unknown']);
  assert.equal(rows[0].progress, '<literal>\nfull progress');
  assert.equal(rows[0].status, 'working');
  assert.equal(rows.at(-1).progress, ''); assert.equal(rows.at(-1).status, 'running');
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
  assert.deepEqual(scoreboardRows([...agents].reverse()), rows);
  assert.equal(agents[0].id, 'b', 'projection does not mutate input');
});
