import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOBILE_QUERY, mobileCards, mobileAgent } from './mobile-state.js';

test('mobile card views/search/tags are local, normalized, read-only projections', () => {
  const cards = [
    { id: 'a', content: 'Alpha', tags: ['Ｃrypto'] },
    { id: 'b', type: 'interactive', title: 'Orbit', tags: ['math'] },
    { id: 'c', content: 'Beta', tags: ['crypto'] },
  ];
  const box = { activeViewId: 'desktop', views: [{ id: 'desktop', placements: [{ cardId: 'c' }] }, { id: 'phone', placements: [{ cardId: 'a' }, { cardId: 'b' }] }] };
  const before = structuredClone({ cards, box });
  assert.deepEqual(mobileCards(cards, box, 'phone').map(c => c.id), ['a', 'b']);
  assert.deepEqual(mobileCards(cards, box, 'phone', 'missing orbit').map(c => c.id), ['b']);
  assert.deepEqual(mobileCards(cards, box, '', '', 'crypto').map(c => c.id), ['a', 'c']);
  assert.deepEqual(mobileCards(cards, box, 'deleted'), []);
  assert.deepEqual({ cards, box }, before, 'no shared activeView, memberships or card mutation');
  assert.equal(MOBILE_QUERY, '(max-width: 767px)');
});

test('mobile Agent lookup excludes the Card box Agent and missing records', () => {
  const state = { agents: [{ id: 'agent' }, { id: 'box', workspace: 'card-box' }] };
  assert.equal(mobileAgent(state, 'agent'), state.agents[0]);
  assert.equal(mobileAgent(state, 'box'), undefined);
  assert.equal(mobileAgent(state, 'missing'), undefined);
});
