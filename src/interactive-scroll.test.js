import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { forwardInteractiveWheel, installInteractiveScrollBridge } from './interactive-scroll.js';

test('parent-side iframe wheels compensate canvas zoom and do not double-handle native child events', () => {
  const messages = [];
  const frame = { clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 150 }), contentWindow: { postMessage: (...args) => messages.push(args) } };
  let prevented = 0, stopped = 0;
  const event = { target: frame, clientX: 60, clientY: 50, deltaX: 0, deltaY: 120, deltaMode: 0, preventDefault: () => prevented++, stopPropagation: () => stopped++ };
  assert.equal(forwardInteractiveWheel(event, frame, 'session'), true);
  assert.deepEqual(messages[0], [{ type: 'agent-canvas-interactive-wheel', token: 'session', x: 100, y: 60, deltaX: 0, deltaY: 120, deltaMode: 0 }, '*']);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.equal(forwardInteractiveWheel({ ...event, target: {} }, frame, 'session'), false);
  assert.equal(forwardInteractiveWheel({ ...event, ctrlKey: true }, frame, 'session'), false);
  assert.equal(forwardInteractiveWheel({ ...event, deltaY: NaN }, frame, 'session'), false);
  assert.equal(messages.length, 1);
});

function fixture() {
  let receive;
  const parent = {};
  const makeNode = (max, parentElement = null) => ({
    parentElement, scrollTop: 0, scrollLeft: 0, clientHeight: 100, clientWidth: 200,
    dispatchEvent: () => true,
    scrollBy({ left, top }) { this.scrollTop = Math.max(0, Math.min(max, this.scrollTop + top)); this.scrollLeft = Math.max(0, Math.min(max, this.scrollLeft + left)); },
  });
  const root = makeNode(1000), nested = makeNode(50, root);
  const context = { parent, innerWidth: 400, innerHeight: 300,
    window: { addEventListener: (_type, handler) => { receive = handler; } },
    document: { elementFromPoint: () => nested },
    getComputedStyle: () => ({ overflowX: 'auto', overflowY: 'auto' }),
    WheelEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  };
  runInNewContext(`(${installInteractiveScrollBridge.toString()})('session')`, context);
  const send = (patch = {}, source = parent) => receive({ source, data: { type: 'agent-canvas-interactive-wheel', token: 'session', x: 50, y: 20, deltaX: 0, deltaY: 30, deltaMode: 0, ...patch } });
  return { root, nested, send };
}

test('sandbox wheel bridge checks source/token and scrolls nearest container before chaining', () => {
  const { root, nested, send } = fixture();
  send({ token: 'wrong' }); send({}, {}); send({ deltaY: NaN }); send({ deltaMode: 5 });
  assert.equal(nested.scrollTop, 0); assert.equal(root.scrollTop, 0);
  send(); assert.equal(nested.scrollTop, 30); assert.equal(root.scrollTop, 0);
  send(); assert.equal(nested.scrollTop, 50); assert.equal(root.scrollTop, 0);
  send(); assert.equal(root.scrollTop, 30);
});

test('sandbox bridge preserves canceled plot wheel handlers and supports line/page deltas', () => {
  const { root, nested, send } = fixture();
  nested.dispatchEvent = () => false;
  send(); assert.equal(nested.scrollTop, 0); assert.equal(root.scrollTop, 0);
  nested.dispatchEvent = () => true;
  send({ deltaMode: 1, deltaY: 1 }); assert.equal(nested.scrollTop, 16);
  nested.scrollTop = 50;
  send({ deltaMode: 2, deltaY: 1, deltaX: 1 });
  assert.equal(nested.scrollLeft, 50);
  send({ deltaMode: 2, deltaY: 1, deltaX: 1 });
  assert.equal(root.scrollTop, 100); assert.equal(root.scrollLeft, 200);
});
