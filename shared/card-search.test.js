import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCards } from './card-search.js';
test('library search uses OR, Unicode normalization, content/title/tags/ID and preserves order', () => {
  const cards = [{ id: 'one', content: 'DH 密鑰交換', tags: ['Crypto'] }, { id: 'two', content: 'Other topic', tags: [] }, { id: 'three', type: 'interactive', title: 'Orbit viewer', tags: [], interactive: { html: 'secret source term' } }];
  assert.deepEqual(searchCards(cards, 'crypto Other'), cards.slice(0, 2));
  assert.deepEqual(searchCards(cards, 'ＣＲＹＰＴＯ'), [cards[0]]);
  assert.deepEqual(searchCards(cards, '密鑰'), [cards[0]]);
  assert.deepEqual(searchCards(cards, 'TWO'), [cards[1]]);
  assert.deepEqual(searchCards(cards, 'orbit'), [cards[2]]);
  assert.deepEqual(searchCards(cards, 'secret'), []);
  assert.deepEqual(searchCards(cards, '  '), cards);
  assert.deepEqual(searchCards(cards, 'missing'), []);
  assert.throws(() => searchCards(cards, 'a'.repeat(1001)));
});
