import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInteractiveDocument, replaceCardAssetUrls, usesInteractiveRuntime } from './interactive-card.js';

const card = { title: 'Demo', interactive: { html: '<img src="card-asset://photo">', css: 'img{background:url(card-asset://photo)}', javascript: 'document.body.textContent="</script>";' } };

test('interactive document is sandbox-oriented, asset-local and keeps scripts behind Play', () => {
  const still = buildInteractiveDocument(card, { photo: 'blob:photo' }, { run: false, nonce: 'n', token: 't' });
  assert.match(still, /default-src 'none'/);
  assert.match(still, /img-src blob: data:/);
  assert.doesNotMatch(still, /document\.body\.textContent/);
  assert.match(still, /blob:photo/);
  const running = buildInteractiveDocument(card, { photo: 'blob:photo' }, { run: true, nonce: 'n', token: 't' });
  assert.match(running, /nonce="n"/);
  assert.match(running, /<\\\/script>/);
  assert.match(running, /agent-canvas-interactive-error/);
});

test('runtime detection and missing asset replacement are deterministic', () => {
  assert.equal(usesInteractiveRuntime(card), true);
  assert.equal(usesInteractiveRuntime({ interactive: { css: '@keyframes spin{}', javascript: '' } }), true);
  assert.equal(usesInteractiveRuntime({ interactive: { css: 'svg{width:100%}', javascript: '' } }), false);
  assert.equal(replaceCardAssetUrls('card-asset://missing', {}), 'about:blank#missing-card-asset');
});
