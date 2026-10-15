import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardStore } from './card-store.js';
import { validateInteractiveAssetName, validateInteractiveSource } from './interactive-card.js';

test('interactive cards validate source, preserve type and revise only source changes', () => {
  const store = new CardStore();
  try {
    const card = store.create({ type: 'interactive', title: '  Orbit  ', html: '<svg viewBox="0 0 10 10"><circle r="4" /></svg>', css: 'svg{width:100%}', javascript: 'console.log("ready")', tags: ['demo'] });
    assert.equal(card.type, 'interactive');
    assert.equal(card.title, 'Orbit');
    assert.equal(card.interactive.revision, 0);
    assert.deepEqual(card.assets, []);
    assert.equal(store.update(card.id, { title: 'Orbit 2' }).interactive.revision, 0);
    assert.equal(store.update(card.id, { javascript: 'document.body.dataset.ready = "yes"' }).interactive.revision, 1);
    assert.throws(() => store.update(card.id, { content: 'wrong type' }), /Invalid interactive/);
    assert.throws(() => store.create({ type: 'interactive', title: 'Bad', html: '<script>alert(1)</script>' }), /script elements/);
    assert.equal(store.create({ content: 'Normal' }).type, 'markdown');
  } finally { store.close(); }
});

test('interactive source and asset names reject unsafe or oversized values', () => {
  assert.throws(() => validateInteractiveSource({ html: '<script src="x"></script>' }), /script elements/);
  assert.throws(() => validateInteractiveSource({ html: '<style>body{color:red}</style>' }), /style elements/);
  assert.throws(() => validateInteractiveSource({ html: '<video autoplay></video>' }), /autoplay/);
  assert.throws(() => validateInteractiveSource({ html: '<iframe src="https://example.com"></iframe>' }), /not allowed/);
  assert.throws(() => validateInteractiveSource({ html: '<a href="https://example.com">leave</a>' }), /resource URLs/);
  assert.equal(validateInteractiveSource({ html: '<svg><use href="#dot"/></svg><img src="card-asset://dot">' }).html.includes('<svg>'), true);
  assert.throws(() => validateInteractiveSource({ html: 'x'.repeat(250 * 1024 + 1) }), /html/);
  assert.equal(validateInteractiveAssetName('background-2.png'), 'background-2.png');
  for (const name of ['', '../secret', 'a/b', 'space name']) assert.throws(() => validateInteractiveAssetName(name), /asset name/);
});
