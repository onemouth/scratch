import { randomUUID } from 'node:crypto';
import { scoreboardRows } from '../shared/scoreboard.js';
import { nativeMemory, memoryName, MEMORY_PROTOCOL, DEFAULT_CAPACITY } from '../shared/canvas-memory.js';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const geometry = ['id', 'x', 'y', 'width', 'height'];
// Explicit allowlists: never project PTY output, prompts, session paths/tokens,
// environment, Interactive source/assets, or the entire persistence snapshot.
export function canvasMemoryProjection({ agents, edges, notes, cards, cardPlacements }) {
  return {
    scoreboard: scoreboardRows(agents),
    agents: agents.map(agent => pick(agent, [...geometry, 'name', 'workspace', 'workdir', 'status', 'activity', 'note', 'processGeneration', 'scoreboardUpdatedAt'])),
    edges: edges.map(edge => pick(edge, ['id', 'source', 'target', 'type', 'label'])),
    notes: notes.map(note => ({ ...pick(note, [...geometry, 'title']), summary: (note.text ?? '').slice(0, 500) })),
    cards: cards.map(card => ({ ...pick(card, ['id', 'type', 'tags', 'links', 'updatedAt']),
      summary: (card.type === 'interactive' ? card.title : card.content ?? '').slice(0, 240) })),
    cardPlacements: cardPlacements.map(placement => pick(placement, [...geometry, 'cardId'])),
  };
}

export function createCanvasMemory({ capacity = DEFAULT_CAPACITY, getState, getAgents = () => getState().agents, onError = console.error } = {}) {
  const native = nativeMemory(), name = memoryName(), epoch = randomUUID();
  if (!['signalCreate', 'signalWatch', 'signalPost', 'signalClose'].every(key => typeof native[key] === 'function')) {
    throw new Error('Canvas native addon is outdated; run npm run build:shm');
  }
  const handle = native.create(name, capacity);
  let revision = 0, timer, closed = false, lastError = '', eventSequence = 0;
  let previous = new Map(getAgents().map(agent => [agent.id, { ...agent }]));
  const events = [], notifiers = new Set();
  const publish = () => {
    if (closed) return;
    try {
      const body = { protocolVersion: MEMORY_PROTOCOL, serverEpoch: epoch, revision: ++revision,
        publishedAt: new Date().toISOString(), notificationVersion: 1, eventSequence, events,
        ...canvasMemoryProjection(getState()) };
      native.write(handle, Buffer.from(JSON.stringify(body)));
      lastError = '';
    } catch (error) {
      native.invalidate(handle); // Never keep presenting a silently old snapshot.
      if (lastError !== error.message) onError(`Canvas shared memory unavailable: ${error.message}`);
      lastError = error.message;
    }
  };
  const createNotifier = () => {
    if (closed) throw new Error('Publisher closed');
    if (notifiers.size >= 256) throw new Error('Canvas notification process limit reached (256)');
    const name = memoryName(), signal = native.signalCreate(name);
    const notifier = { name, post: () => native.signalPost(signal), close() {
      if (notifiers.delete(notifier)) native.signalClose(signal);
    } };
    notifiers.add(notifier); return notifier;
  };
  const observeAgents = () => {
    if (closed) return;
    const current = new Map(getAgents().map(agent => [agent.id, { ...agent }]));
    const append = (type, agent, prior) => {
      events.push({ sequence: ++eventSequence, type, agentId: agent.id, name: agent.name,
        generation: agent.processGeneration ?? prior?.processGeneration ?? null,
        status: agent.status, activity: agent.activity,
        ...(type === 'progress' ? { summary: agent.note ?? '' } : {}), initial: ['working', 'idle'].includes(type) && prior?.activity === 'unknown' });
      if (events.length > 256) events.shift();
    };
    const before = eventSequence;
    for (const [id, agent] of current) {
      const prior = previous.get(id);
      if (!prior || (agent.processGeneration && agent.processGeneration !== prior.processGeneration)) append('started', agent, prior);
      else if (prior.status === 'running' && agent.status !== 'running') append('stopped', agent, prior);
      if (agent.status === 'running' && agent.activity !== prior?.activity && ['working', 'idle'].includes(agent.activity)) append(agent.activity, agent, prior);
      if (prior && agent.note !== prior.note) append('progress', agent, prior);
    }
    for (const [id, agent] of previous) if (!current.has(id)) append('removed', agent, agent);
    previous = current;
    if (eventSequence !== before) {
      publish(); // Event transitions bypass the browser's snapshot coalescing.
      for (const notifier of notifiers) {
        try { notifier.post(); }
        catch (error) { notifier.close(); onError(`Canvas notification channel closed: ${error.message}`); }
      }
    }
  };
  const close = () => {
    if (!closed) {
      closed = true; clearInterval(timer); native.close(handle);
      for (const notifier of [...notifiers]) notifier.close();
    }
  };
  try {
    publish();
    timer = setInterval(() => native.touch(handle), 1000);
    timer.unref();
    return { name, epoch, publish, observeAgents, createNotifier, close, get error() { return lastError; } };
  } catch (error) { close(); throw error; }
}
