import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCards } from './card-search.js';
test('library search uses OR, Unicode normalization, content/tags/ID and preserves order', () => {
  const cards = [{ id: 'one', content: 'DH 密鑰交換', tags: ['Crypto'] }, { id: 'two', content: 'Other topic', tags: [] }];
  assert.deepEqual(searchCards(cards, 'crypto Other'), cards);
  assert.deepEqual(searchCards(cards, 'ＣＲＹＰＴＯ'), [cards[0]]);
  assert.deepEqual(searchCards(cards, '密鑰'), [cards[0]]);
  assert.deepEqual(searchCards(cards, 'TWO'), [cards[1]]);
  assert.deepEqual(searchCards(cards, '  '), cards);
  assert.deepEqual(searchCards(cards, 'missing'), []);
  assert.throws(() => searchCards(cards, 'a'.repeat(1001)));
});
