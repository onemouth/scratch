import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaDropFiles, MEDIA } from './card-media.js';

test('drag/drop accepts at most one of each supported kind and validates size before upload', () => {
  const image = { name: 'Image.PNG', size: 100 }, audio = { name: 'voice.m4a', size: 200 };
  assert.deepEqual(mediaDropFiles([audio, image]).map(item => item.kind), ['audio', 'image']);
  assert.throws(() => mediaDropFiles([image, image]), /at most one/);
  assert.throws(() => mediaDropFiles([{ name: 'bad.svg', size: 100 }]), /Use JPEG/);
  assert.throws(() => mediaDropFiles([{ ...image, size: 0 }]), /non-empty/);
  assert.throws(() => mediaDropFiles([{ ...image, size: MEDIA.image.limit + 1 }]), /10 MB/);
  assert.throws(() => mediaDropFiles([{ ...audio, size: MEDIA.audio.limit + 1 }]), /50 MB/);
  assert.equal(mediaDropFiles([{ name: 'photo.jfif', type: 'image/jpeg', size: 100 }])[0].kind, 'image');
  assert.deepEqual(mediaDropFiles([]), []);
});
