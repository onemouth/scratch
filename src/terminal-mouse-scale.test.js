import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctTerminalMouseScale, unscalePointer } from './terminal-mouse-scale.js';

const element = (scaleX, scaleY = scaleX) => ({
  offsetWidth: 400, offsetHeight: 200,
  getBoundingClientRect: () => ({ left: 150, top: 80, width: 400 * scaleX, height: 200 * scaleY }),
});

test('terminal selection and mouse reports undo React Flow zoom', () => {
  const mouse = {
    getCoords(event, _element, cols, rows, selecting) { return [event.clientX, event.clientY, cols, rows, selecting]; },
    getMouseReportCoords(event) { return [event.clientX, event.clientY]; },
  };
  assert.equal(correctTerminalMouseScale({ _core: { _mouseService: mouse } }), true);
  const event = { clientX: 250, clientY: 130 };
  assert.deepEqual(mouse.getCoords(event, element(0.5), 80, 24, true), [350, 180, 80, 24, true]);
  assert.deepEqual(mouse.getMouseReportCoords(event, element(0.5)), [350, 180]);
  assert.deepEqual(mouse.getCoords(event, element(2), 80, 24, true), [200, 105, 80, 24, true]);
  assert.deepEqual(mouse.getCoords(event, element(1), 80, 24, true), [250, 130, 80, 24, true]);
  assert.deepEqual(event, { clientX: 250, clientY: 130 });
});

test('no terminal internals or unmeasured element leaves coordinates alone', () => {
  assert.equal(correctTerminalMouseScale({}), false);
  const event = { clientX: 250, clientY: 130 };
  assert.equal(unscalePointer(event, element(0)), event);
});
