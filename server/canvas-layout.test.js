import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasLayout, layoutPatch, rectanglesOverlap } from './canvas-layout.js';

test('layout geometry permits touching edges/negative positions but validates finite dimensions', () => {
  const a = { x: -100, y: -20, width: 100, height: 50 };
  assert.equal(rectanglesOverlap(a, { x: 0, y: -20, width: 100, height: 50 }), false);
  assert.equal(rectanglesOverlap(a, { x: -1, y: -20, width: 100, height: 50 }), true);
  assert.deepEqual(layoutPatch({ x: -2, width: 320 }, { width: 320 }), { x: -2, width: 320 });
  for (const patch of [{ x: null }, { x: NaN }, { height: Infinity }, { width: 239 }]) assert.throws(() => layoutPatch(patch));
  const layout = new CanvasLayout(() => []);
  assert.throws(() => layout.assertAvailable({ x: 1e308, y: 0, width: 1e308, height: 240 }));
});

test('collision checks exclude only the target and require removing all existing overlap', () => {
  const objects = [{ kind: 'note', id: 'one', x: 0, y: 0, width: 200, height: 200 }, { kind: 'card', id: 'two', x: 100, y: 100, width: 240, height: 240 }];
  const layout = new CanvasLayout(() => objects);
  assert.throws(() => layout.assertAvailable({ ...objects[0], x: -10 }, objects[0]), error => error.status === 409 && error.code === 'LAYOUT_CONFLICT' && error.conflicts[0].id === 'two');
  assert.doesNotThrow(() => layout.assertAvailable({ ...objects[0], x: -200 }, objects[0]));
});

test('human leases are multi-owner, renewable, expire without persistence and are target-specific', () => {
  let now = 100;
  const object = { kind: 'note', id: 'one', x: 0, y: 0, width: 200, height: 200 };
  const layout = new CanvasLayout(() => [object], { now: () => now, leaseMs: 1000 });
  layout.interaction('note', 'one', 'tab-a', 'start');
  layout.interaction('note', 'one', 'tab-b', 'start');
  layout.interaction('note', 'one', 'tab-a', 'end');
  assert.throws(() => layout.assertAvailable({ ...object, x: 500 }, object), error => error.code === 'LAYOUT_BUSY');
  now += 500; layout.interaction('note', 'one', 'tab-b', 'renew');
  now += 700; assert.equal(layout.snapshot().objects[0].busy, true);
  now += 301; assert.equal(layout.snapshot().objects[0].busy, false);
  assert.doesNotThrow(() => layout.assertAvailable({ ...object, x: 500 }, object));
  assert.throws(() => layout.interaction('agent', 'missing', 'tab-a', 'start'), error => error.status === 404);
  layout.interaction('note', 'one', 'tab-a', 'start'); layout.forget('note', 'one');
  assert.equal(layout.busy('note', 'one'), false);
});
