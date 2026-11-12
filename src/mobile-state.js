import { searchCards } from '../shared/card-search.js';

export const MOBILE_QUERY = '(max-width: 767px)';
export const normalizeTag = tag => tag.normalize('NFKC').toLocaleLowerCase('en');
export function mobileCards(cards, box, viewId, query = '', tag = '') {
  const view = box?.views?.find(view => view.id === viewId);
  // A deleted view must not silently broaden the selection to the whole library.
  const members = new Set(view?.placements?.map(p => p.cardId));
  const selected = viewId ? cards.filter(card => view && members.has(card.id)) : cards;
  return searchCards(selected, query).filter(card => !tag || card.tags.some(value => normalizeTag(value) === normalizeTag(tag)));
}
export const mobileAgent = (state, id) => state.agents?.find(agent => agent.id === id && agent.workspace !== 'card-box');
