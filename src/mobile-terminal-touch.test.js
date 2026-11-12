import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachTerminalTouchScroll, HISTORY_SWIPE_SPEED } from './mobile-terminal-touch.js';

function fixture() {
  const handlers = new Map(), lines = [];
  const viewport = { get scrollTop() { return 0; }, set scrollTop(_) {}, addEventListener(type, fn, options) { handlers.set(type, { fn, options }); }, removeEventListener(type) { handlers.delete(type); } };
  const screen = { style: { height: '180px' } };
  const terminal = { rows: 10, element: { querySelector: () => screen }, scrollLines: count => lines.push(count) };
  const cleanup = attachTerminalTouchScroll(viewport, terminal, () => {});
  const point = (x, y, identifier = 1) => ({ clientX: x, clientY: y, identifier });
  const dispatch = (type, touches) => {
    const event = { touches, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    handlers.get(type)?.fn(event); return event;
  };
  return { handlers, lines, screen, cleanup, point, dispatch };
}

test('history swipe is twice as fast and leaves glyph positions untouched', () => {
  const f = fixture();
  assert.equal(HISTORY_SWIPE_SPEED, 2);
  f.dispatch('touchstart', [f.point(20, 100)]);
  assert.equal(f.dispatch('touchmove', [f.point(20, 154)]).prevented, true);
  assert.deepEqual(f.lines, [-6]);
  f.dispatch('touchmove', [f.point(20, 118)]);
  assert.deepEqual(f.lines, [-6, 4]);
  assert.equal(f.screen.style.transform, undefined);
  assert.deepEqual(f.handlers.get('touchmove').options, { capture: true, passive: false });
  f.cleanup(); assert.equal(f.handlers.size, 0);
});

test('small deltas accumulate without translating text or scrolling horizontal gestures', () => {
  const f = fixture();
  f.dispatch('touchstart', [f.point(20, 100)]);
  f.dispatch('touchmove', [f.point(20, 106)]);
  f.dispatch('touchmove', [f.point(20, 109)]);
  assert.deepEqual(f.lines, [-1]);
  f.dispatch('touchend', []);
  f.dispatch('touchstart', [f.point(20, 100)]);
  assert.equal(f.dispatch('touchmove', [f.point(80, 103)]).prevented, false);
  assert.equal(f.dispatch('touchmove', [f.point(80, 200)]).prevented, false);
  assert.deepEqual(f.lines, [-1]); f.cleanup();
});

test('multitouch and canceled gestures cannot scroll history', () => {
  const f = fixture();
  f.dispatch('touchstart', [f.point(20, 100), f.point(60, 100, 2)]);
  assert.equal(f.dispatch('touchmove', [f.point(20, 160)]).prevented, false);
  f.dispatch('touchstart', [f.point(20, 100)]); f.dispatch('touchcancel', []);
  assert.equal(f.dispatch('touchmove', [f.point(20, 160)]).prevented, false);
  assert.deepEqual(f.lines, []); f.cleanup();
});
