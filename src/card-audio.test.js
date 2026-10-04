import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCardAudioController, audioTime } from './card-audio.js';

class AudioMock {
  handlers = new Map();
  currentTime = 0;
  duration = 12;
  paused = true;
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  loadCalls = 0;
  load() { this.loadCalls++; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  emit(name) { this.handlers.get(name)?.(); }
}
test('one shared player: no autoplay, pause/resume, seek, file switching and unlink cleanup', async () => {
  let created = 0, element;
  const controller = createCardAudioController(() => { created++; element = new AudioMock(); return element; });
  const a = { id: 'a', url: '/a' }, b = { id: 'b', url: '/b' };
  assert.equal(created, 0);
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => notifications++);
  await controller.toggle(a);
  assert.equal(created, 1); assert.equal(controller.getSnapshot().playing, true);
  element.emit('loadedmetadata');
  controller.seek('a', 5);
  assert.equal(element.currentTime, 5);
  assert.equal(controller.getSnapshot().time, 5);
  controller.reconcile([{ audio: a }]); // Switching Canvas does not stop it.
  assert.equal(element.paused, false);
  await controller.toggle(a);
  assert.equal(controller.getSnapshot().playing, false);
  await controller.toggle(a);
  assert.equal(element.currentTime, 5);
  await controller.toggle(b);
  assert.equal(created, 1); assert.equal(element.src, '/b');
  assert.equal(controller.getSnapshot().fileId, 'b');
  assert.equal(controller.getSnapshot().time, 0);
  element.emit('ended');
  assert.equal(controller.getSnapshot().playing, false);
  controller.reconcile([{ audio: a }]);
  assert.equal(controller.getSnapshot().fileId, null);
  assert.equal(element.paused, true);
  assert.ok(notifications > 0); unsubscribe();
  assert.equal(audioTime(65), '1:05');
});
test('retrying a failed source reloads it instead of keeping a stale media error', async () => {
  const element = new AudioMock();
  const controller = createCardAudioController(() => element);
  const file = { id: 'a', url: '/a' };
  await controller.toggle(file);
  element.emit('error');
  assert.ok(controller.getSnapshot().error);
  await controller.toggle(file);
  assert.equal(element.loadCalls, 1);
  assert.equal(controller.getSnapshot().error, '');
  assert.equal(controller.getSnapshot().playing, true);
});
test('late playback rejection cannot overwrite the newer player state', async () => {
  const element = new AudioMock();
  let reject;
  element.play = () => new Promise((_, fail) => { reject = fail; });
  const controller = createCardAudioController(() => element);
  const pending = controller.toggle({ id: 'a', url: '/a' });
  await controller.toggle({ id: 'a', url: '/a' }); // Pause while play is pending.
  reject(new Error('Cancelled'));
  await pending;
  assert.equal(controller.getSnapshot().playing, false);
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().error, '');
});
