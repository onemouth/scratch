const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en');
export function searchCards(cards, query = '') {
  if (typeof query !== 'string' || query.length > 1000) throw new Error('Search query must be at most 1,000 characters');
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return cards;
  return cards.filter(card => {
    const text = normalize([card.id, card.type === 'interactive' ? card.title : card.content, ...(card.tags || [])].join('\n'));
    return terms.some(term => text.includes(term));
  });
}
