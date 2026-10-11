import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCardContent, validateCardContent } from './card-content.js';

test('counts CJK characters and English words, not Markdown formatting', () => {
  assert.equal(inspectCardContent('# 中文\n\n**hello** [world](https://example.com) \n\n日本語 한글'), 9);
  assert.equal(inspectCardContent('**hel**lo world'), 2);
  assert.equal(inspectCardContent('你好 hello-world 123'), 5);
  assert.equal(inspectCardContent(' \,\n !!!'), 0);
  assert.equal(inspectCardContent('か\u3099'), 1);
  assert.equal(inspectCardContent('> hello\n\n- world\n\n`some code`'), 4);
});
test('math counts argument text, variables and numbers, excluding command names', () => {
  assert.equal(inspectCardContent('$\\frac{a}{b}$'), 2);
  assert.equal(inspectCardContent('$$\n\\frac{a}{b}\n$$'), 2);
  assert.equal(inspectCardContent('```math\n\\frac{a}{b}\n```'), 2);
  assert.equal(inspectCardContent('$\\text{中文 hello} + x + 2$'), 5);
  assert.equal(inspectCardContent('word$x$word'), 3);
  assert.equal(inspectCardContent('`\\frac{a}{b}`'), 3);
  assert.equal(inspectCardContent('```latex\n\\frac{a}{b}\n```'), 3);
  assert.equal(inspectCardContent('Prices: \\$5 and \\$10'), 4);
  assert.equal(inspectCardContent('$\\unknown{x}$'), 1);
  assert.equal(validateCardContent('$\\text{' + '中'.repeat(400) + '}$'), 400);
  assert.throws(() => validateCardContent('$\\text{' + '中'.repeat(401) + '}$'), /400/);
  assert.throws(() => validateCardContent('$\\text{' + 'word '.repeat(401) + '}$'), /400/);
});

test('400-unit boundaries and text-only Markdown', () => {
  assert.equal(validateCardContent('中'.repeat(400)), 400);
  assert.equal(validateCardContent('word '.repeat(400)), 400);
  assert.equal(validateCardContent('中'.repeat(200) + ' word'.repeat(200)), 400);
  assert.throws(() => validateCardContent('中'.repeat(401)), /400/);
  assert.throws(() => validateCardContent('word '.repeat(401)), /400/);
  for (const content of ['![x](image.png)', '<div>raw</div>', '![x][ref]\n\n[ref]: image.png']) assert.throws(() => validateCardContent(content), /text Markdown/);
  assert.throws(() => validateCardContent(' '.repeat(20001)), /source/);
});
