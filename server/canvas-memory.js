import { randomUUID } from 'node:crypto';
import { nativeMemory, memoryName, MEMORY_PROTOCOL, DEFAULT_CAPACITY } from '../shared/canvas-memory.js';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const geometry = ['id', 'x', 'y', 'width', 'height'];
// Explicit allowlists: never project PTY output, prompts, session paths/tokens,
// environment, Interactive source/assets, or the entire persistence snapshot.
export function canvasMemoryProjection({ agents, edges, notes, cards, cardPlacements }) {
  return {
    agents: agents.map(agent => pick(agent, [...geometry, 'name', 'workspace', 'workdir', 'status', 'activity', 'note'])),
    edges: edges.map(edge => pick(edge, ['id', 'source', 'target', 'type', 'label'])),
    notes: notes.map(note => ({ ...pick(note, [...geometry, 'title']), summary: (note.text ?? '').slice(0, 500) })),
    cards: cards.map(card => ({ ...pick(card, ['id', 'type', 'tags', 'links', 'updatedAt']),
      summary: (card.type === 'interactive' ? card.title : card.content ?? '').slice(0, 240) })),
    cardPlacements: cardPlacements.map(placement => pick(placement, [...geometry, 'cardId'])),
  };
}

export function createCanvasMemory({ capacity = DEFAULT_CAPACITY, getState, onError = console.error } = {}) {
  const native = nativeMemory(), name = memoryName(), epoch = randomUUID();
  const handle = native.create(name, capacity);
  let revision = 0, timer, closed = false, lastError = '';
  const publish = () => {
    if (closed) return;
    try {
      const body = { protocolVersion: MEMORY_PROTOCOL, serverEpoch: epoch, revision: ++revision,
        publishedAt: new Date().toISOString(), ...canvasMemoryProjection(getState()) };
      native.write(handle, Buffer.from(JSON.stringify(body)));
      lastError = '';
    } catch (error) {
      native.invalidate(handle); // Never keep presenting a silently old snapshot.
      if (lastError !== error.message) onError(`Canvas shared memory unavailable: ${error.message}`);
      lastError = error.message;
    }
  };
  const close = () => { if (!closed) { closed = true; clearInterval(timer); native.close(handle); } };
  try {
    publish();
    timer = setInterval(() => native.touch(handle), 1000);
    timer.unref();
    return { name, epoch, publish, close, get error() { return lastError; } };
  } catch (error) { close(); throw error; }
}
