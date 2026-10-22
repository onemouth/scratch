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
  assert.match(still, /#interactive-root\{overflow:auto;overscroll-behavior:contain\}/);
  const running = buildInteractiveDocument(card, { photo: 'blob:photo' }, { run: true, nonce: 'n', token: 't' });
  assert.match(running, /nonce="n"/);
  assert.match(running, /<\\\/script>/);
  assert.match(running, /agent-canvas-interactive-error/);
});

test('bundled JSXGraph is inert until Play and precedes agent code without relaxing CSP', () => {
  const jsxgraph = { javascript: 'window.JXG={fixture:true};', css: '.jxgbox{position:relative}' };
  const paused = buildInteractiveDocument(card, {}, { nonce: 'n', token: 't', jsxgraph });
  assert.doesNotMatch(paused, /window\.JXG/);
  assert.match(paused, /\.jxgbox/);
  const running = buildInteractiveDocument(card, {}, { run: true, nonce: 'n', token: 't', jsxgraph });
  assert.ok(running.indexOf(jsxgraph.javascript) < running.indexOf('document.body.textContent'));
  assert.match(running, /script-src 'nonce-n'/);
  assert.doesNotMatch(running, /unsafe-eval|wasm-unsafe-eval|https:\/\//);
});

test('runtime detection and missing asset replacement are deterministic', () => {
  assert.equal(usesInteractiveRuntime(card), true);
  assert.equal(usesInteractiveRuntime({ interactive: { css: '@keyframes spin{}', javascript: '' } }), true);
  assert.equal(usesInteractiveRuntime({ interactive: { css: 'svg{width:100%}', javascript: '' } }), false);
  assert.equal(replaceCardAssetUrls('card-asset://missing', {}), 'about:blank#missing-card-asset');
});
