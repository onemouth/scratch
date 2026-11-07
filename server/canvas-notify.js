import { randomUUID } from 'node:crypto';
import { nativeMemory, openCanvasMemory } from '../shared/canvas-memory.js';

export const EVENT_TYPES = ['started', 'working', 'idle', 'stopped', 'removed', 'progress'];

// Per-Pi, session-scoped subscriptions. Semaphore callbacks carry hints only;
// ordered SHM records are the source of truth. No HTTP or LLM calls here.
export function createCanvasSubscriptions({ name, epoch, signalName, deliver, onError,
  open = openCanvasMemory, native = nativeMemory(), watchdogMs = 1000 }) {
  const subscriptions = new Map();
  let watcher, timer, closed = false;
  const read = () => {
    const reader = open(name, epoch);
    try {
      const snapshot = reader.read();
      if (snapshot.notificationVersion !== 1 || !Number.isSafeInteger(snapshot.eventSequence) || !Array.isArray(snapshot.events)) {
        throw Object.assign(new Error('Shared-memory event protocol unavailable'), { code: 'SHM_VERSION' });
      }
      return snapshot;
    } finally { reader.close(); }
  };
  const stop = () => {
    clearInterval(timer); timer = undefined;
    if (watcher) { native.signalClose(watcher); watcher = undefined; }
  };
  const drain = () => {
    if (closed || !subscriptions.size) return;
    try {
      const snapshot = read();
      const oldest = snapshot.events[0]?.sequence ?? snapshot.eventSequence + 1;
      let deliveries = 0;
      for (const [id, sub] of subscriptions) {
        if (sub.cursor < oldest - 1 || sub.cursor > snapshot.eventSequence) {
          subscriptions.delete(id);
          onError(Object.assign(new Error(`Subscription ${id} lost events; read current state and subscribe again`), { code: 'SHM_EVENTS_LOST' }));
          continue;
        }
        const pending = snapshot.events.filter(event => event.sequence > sub.cursor);
        // Advance before delivering: extension callbacks can mutate subscriptions.
        sub.cursor = snapshot.eventSequence;
        for (const event of pending) {
          if (!subscriptions.has(id)) break;
          if (event.agentId !== sub.agentId || !sub.events.includes(event.type) || (sub.generation && event.generation !== sub.generation)) continue;
          if (++deliveries > 64) throw Object.assign(new Error('Notification burst exceeded 64 deliveries; read current state and resubscribe'), { code: 'SHM_NOTIFICATION_LIMIT' });
          if (sub.once) subscriptions.delete(id);
          deliver({ subscriptionId: id, serverEpoch: epoch, ...event }, sub);
        }
      }
      if (!subscriptions.size) stop();
    } catch (error) {
      if (error.code === 'SHM_BUSY') return; // A queued signal/watchdog will retry.
      subscriptions.clear(); stop(); onError(error);
    }
  };
  return {
    subscribe({ agentId, events = ['idle', 'stopped', 'removed'], delivery = 'notification', wake = false, once = false, generation } = {}) {
      if (closed) throw new Error('Notification session closed');
      if (typeof agentId !== 'string' || !agentId || !Array.isArray(events) || !events.length || events.length > EVENT_TYPES.length ||
          events.some(type => !EVENT_TYPES.includes(type)) || !['notification', 'nextTurn', 'followUp'].includes(delivery) ||
          typeof wake !== 'boolean' || typeof once !== 'boolean' || (wake && delivery !== 'followUp') ||
          (generation !== undefined && (typeof generation !== 'string' || !generation))) throw new Error('Invalid subscription');
      if (delivery === 'followUp' && !once) throw new Error('followUp delivery requires once:true to prevent recurring agent wake loops');
      if (subscriptions.size >= 32) throw new Error('At most 32 subscriptions per Pi session');
      if (!signalName) throw new Error('Native notification channel is not configured');
      const snapshot = read();
      if (!snapshot.agents.some(agent => agent.id === agentId)) throw new Error('Agent not found');
      const id = randomUUID();
      const sub = { agentId, events: [...new Set(events)], delivery, wake, once, generation, cursor: snapshot.eventSequence };
      subscriptions.set(id, sub);
      try {
        if (!watcher) {
          watcher = native.signalWatch(signalName, drain);
          timer = setInterval(drain, watchdogMs); timer.unref();
        }
        drain(); // Recheck after registration: never lose the read→arm race.
        if (!subscriptions.has(id) && !once) throw new Error('Subscription became unavailable during registration');
        return { subscriptionId: id, agentId, events: sub.events, delivery, wake, once, generation: generation ?? null,
          scope: generation ? 'process-generation' : 'agent-id-across-restarts', serverEpoch: epoch, cursor: sub.cursor, active: subscriptions.has(id) };
      } catch (error) { subscriptions.delete(id); if (!subscriptions.size) stop(); throw error; }
    },
    unsubscribe(id) {
      const removed = id === '*' ? subscriptions.size : Number(subscriptions.has(id));
      if (id === '*') subscriptions.clear(); else subscriptions.delete(id);
      if (!subscriptions.size) stop();
      return { removed };
    },
    close() { if (!closed) { closed = true; subscriptions.clear(); stop(); } },
    get size() { return subscriptions.size; },
  };
}
