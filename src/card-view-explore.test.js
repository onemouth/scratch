import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsWithExactTag, recursivelyLinkedCards, uniqueViewName } from './card-view-explore.js';

const cards = [
  { id: 'a', tags: ['Ｃrypto'], links: ['b', 'missing'] },
  { id: 'b', tags: ['crypto notes'], links: [] },
  { id: 'c', tags: ['CRYPTO'], links: ['d'] },
  { id: 'd', tags: [], links: ['b'] },
  { id: 'e', tags: ['other'], links: [] },
];

test('tag exploration uses an exact case-insensitive NFKC match', () => {
  assert.deepEqual(cardsWithExactTag(cards, 'crypto'), ['a', 'c']);
  assert.deepEqual(cardsWithExactTag(cards, 'crypt'), []);
  assert.deepEqual(cardsWithExactTag(cards, 'crypto notes'), ['b']);
});

test('linked exploration includes source, target and the full undirected component', () => {
  assert.deepEqual(recursivelyLinkedCards(cards, 'a', 'b'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(recursivelyLinkedCards(cards, 'e', 'missing'), ['e']);
});

test('generated temporary names avoid existing normalized names', () => {
  assert.equal(uniqueViewName('Tag: crypto', [{ name: 'tag: CRYPTO' }]), 'Tag: crypto (2)');
  assert.equal(uniqueViewName('Linked: a', []), 'Linked: a');
});
