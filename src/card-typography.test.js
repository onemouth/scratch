import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTypography, viewportWidth, subscribeViewportWidth } from './card-typography.js';

test('card typography follows CSS viewport width with clamped, continuous endpoints', () => {
  for (const width of [320, 800, 1024]) assert.deepEqual(cardTypography(width), { base: 11, minimum: 10, fontSize: 11 });
  assert.deepEqual(cardTypography(1232), { base: 12, minimum: 10.5, fontSize: 12 });
  for (const width of [1440, 2379, 3840]) assert.deepEqual(cardTypography(width), { base: 13, minimum: 11, fontSize: 13 });
  assert.ok(cardTypography(1025).base > cardTypography(1024).base);
  assert.ok(cardTypography(1439).base < cardTypography(1440).base);
});

test('canvas zoom retains the responsive screen-pixel floor and normal zoom-in scaling', () => {
  for (const width of [800, 1232, 2379]) {
    const normal = cardTypography(width);
    for (const zoom of [0.2, 0.5, 1, 2]) {
      const result = cardTypography(width, zoom);
      assert.equal(result.fontSize * zoom, Math.max(normal.base * zoom, normal.minimum));
    }
  }
  assert.equal(cardTypography(800, 0.5).fontSize, 20);
  assert.equal(cardTypography(2379, 0.5).fontSize, 22);
});

test('invalid dimensions never produce invalid CSS font sizes', () => {
  assert.deepEqual(cardTypography(NaN), cardTypography(1440));
  for (const zoom of [0, -1, NaN, Infinity]) assert.deepEqual(cardTypography(800, zoom), cardTypography(800));
});

test('viewport subscription follows window resize and removes its listener', () => {
  const original = globalThis.window;
  const listeners = new Set();
  try {
    globalThis.window = { innerWidth: 800, addEventListener(type, listener) { assert.equal(type, 'resize'); listeners.add(listener); }, removeEventListener(type, listener) { assert.equal(type, 'resize'); listeners.delete(listener); } };
    let updates = 0;
    const unsubscribe = subscribeViewportWidth(() => updates++);
    assert.equal(viewportWidth(), 800);
    window.innerWidth = 1440;
    for (const listener of listeners) listener();
    assert.equal(updates, 1);
    assert.equal(viewportWidth(), 1440);
    unsubscribe();
    assert.equal(listeners.size, 0);
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
});
