import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeViewResponse, mergeViewSnapshot, nodeMeasurement } from './card-view-state.js';
test('metadata updates preserve node measurements but dimension changes invalidate them', () => {
  const measured = { width: 340, height: 320 }, old = { style: { width: 340, height: 320 }, measured };
  assert.equal(nodeMeasurement(old, 340, 320), measured);
  assert.equal(nodeMeasurement(old, 500, 320), undefined);
  assert.equal(nodeMeasurement(null, 340, 320), undefined);
});
test('older mutation replies and buffered same-epoch SSE cannot revert view state', () => {
  const current = { agents: [], cardBox: { epoch: 'one', revision: 10, activeViewId: 'new' } };
  const old = { epoch: 'one', revision: 9, activeViewId: 'old' };
  assert.equal(mergeViewResponse(current, old), current);
  const snapshot = mergeViewSnapshot(current, { agents: [{ id: 'live' }], cardBox: old });
  assert.equal(snapshot.cardBox, current.cardBox); assert.equal(snapshot.agents[0].id, 'live');
  const newer = { epoch: 'one', revision: 11, activeViewId: 'latest' };
  assert.equal(mergeViewResponse(current, newer).cardBox, newer);
});
test('authoritative SSE accepts recovered lower revisions from a new backend epoch', () => {
  const old = { cardBox: { epoch: 'old-process', revision: 100 } };
  const recovered = { agents: [], cardBox: { epoch: 'new-process', revision: 90 } };
  assert.equal(mergeViewSnapshot(old, recovered), recovered);
  assert.equal(mergeViewResponse(recovered, old.cardBox), recovered);
  assert.equal(mergeViewResponse({ agents: [] }, recovered.cardBox).cardBox, recovered.cardBox);
});
