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
test('600-unit boundaries and text-only Markdown', () => {
  assert.equal(validateCardContent('中'.repeat(600)), 600);
  assert.equal(validateCardContent('word '.repeat(600)), 600);
  assert.equal(validateCardContent('中'.repeat(300) + ' word'.repeat(300)), 600);
  assert.throws(() => validateCardContent('中'.repeat(601)), /600/);
  assert.throws(() => validateCardContent('word '.repeat(601)), /600/);
  for (const content of ['![x](image.png)', '<div>raw</div>', '![x][ref]\n\n[ref]: image.png']) assert.throws(() => validateCardContent(content), /text Markdown/);
  assert.throws(() => validateCardContent(' '.repeat(20001)), /source/);
});
