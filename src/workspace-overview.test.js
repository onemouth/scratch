import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceOverview } from './workspace-overview.js';
const node = (id, workspace, x, y, width = 340, height = 320) => ({ id, data: { workspace }, position: { x, y }, style: { width, height } });

test('overview ignores other workspace nodes in both rectangles and bounds', () => {
  const active = node('card', 'card-box', 540, 80);
  const foreign = node('agent', 'agents', -100000, 200000);
  const view = { x: 0, y: 0, zoom: 1 };
  const expected = workspaceOverview([active], 'card-box', view, 1000, 700);
  assert.deepEqual(workspaceOverview([foreign, active], 'card-box', view, 1000, 700), expected);
  assert.deepEqual(expected.rectangles.map(rect => rect.id), ['card']);
  assert.deepEqual(workspaceOverview([foreign, active], 'agents', view, 1000, 700).rectangles.map(rect => rect.id), ['agent']);
});

test('overview handles an empty workspace, negative coordinates, measured dimensions and zoom', () => {
  const viewport = { x: 100, y: 50, zoom: 0.5 };
  const empty = workspaceOverview([], 'card-box', viewport, 1000, 700);
  assert.deepEqual(empty.view, { x: -200, y: -100, width: 2000, height: 1400 });
  assert.ok(Number.isFinite(empty.bounds.width));
  const card = { ...node('wide', 'card-box', -300, -400), measured: { width: 3000, height: 2000 } };
  const result = workspaceOverview([card], 'card-box', viewport, 1000, 700);
  assert.equal(result.rectangles[0].width, 3000);
  assert.ok(result.bounds.x <= -300);
  assert.ok(result.bounds.y <= -400);
  assert.ok(result.bounds.x + result.bounds.width >= 2700);
  assert.ok(result.bounds.y + result.bounds.height >= 1600);
  assert.ok(Math.abs(result.bounds.width / result.bounds.height - 4 / 3) < 1e-12);
});
