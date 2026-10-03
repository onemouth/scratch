// Initial/append-only layout. Existing positions and sizes are never rearranged.
export function syncCardBoxPlacements(placements, cards) {
  const ids = new Set(cards.map(card => card.id));
  for (const id of placements.keys()) if (!ids.has(id)) placements.delete(id);
  let slot = 0;
  for (const card of cards) {
    if (placements.has(card.id)) continue;
    let placement;
    do {
      placement = { id: card.id, cardId: card.id, x: 540 + (slot % 4) * 380, y: 80 + Math.floor(slot / 4) * 360, width: 340, height: 320 };
      slot++;
    } while ([...placements.values()].some(p => placement.x < p.x + p.width + 20 && placement.x + placement.width + 20 > p.x && placement.y < p.y + p.height + 20 && placement.y + placement.height + 20 > p.y));
    placements.set(card.id, placement);
  }
}
