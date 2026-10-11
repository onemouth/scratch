const normalized = value => value.normalize('NFKC').toLocaleLowerCase('en');

export function cardsWithExactTag(cards, tag) {
  const wanted = normalized(tag);
  return cards.filter(card => (card.tags || []).some(value => normalized(value) === wanted)).map(card => card.id);
}

export function recursivelyLinkedCards(cards, sourceId, linkedId) {
  const ids = new Set(cards.map(card => card.id));
  const adjacent = new Map(cards.map(card => [card.id, new Set()]));
  for (const card of cards) {
    for (const linked of card.links || []) {
      if (!ids.has(linked)) continue;
      adjacent.get(card.id).add(linked);
      adjacent.get(linked).add(card.id);
    }
  }
  const found = new Set(), queue = [sourceId, linkedId].filter(id => ids.has(id));
  while (queue.length) {
    const id = queue.shift();
    if (found.has(id)) continue;
    found.add(id);
    for (const next of adjacent.get(id) || []) if (!found.has(next)) queue.push(next);
  }
  return cards.filter(card => found.has(card.id)).map(card => card.id);
}

export function uniqueViewName(base, views) {
  const names = new Set(views.map(view => normalized(view.name)));
  if (!names.has(normalized(base))) return base;
  for (let suffix = 2; ; suffix++) {
    const ending = ` (${suffix})`;
    const candidate = base.slice(0, 120 - ending.length) + ending;
    if (!names.has(normalized(candidate))) return candidate;
  }
}
