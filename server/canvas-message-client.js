import { randomUUID } from 'node:crypto';
import { openCanvasMemory, transientMemoryError } from '../shared/canvas-memory.js';
import { MESSAGE_VERSION, QUEUE_SLOTS, MAX_TTL_MS, messagingNative, messageQueue, validateSend, messageError, validMessageId, validId } from '../shared/canvas-messages.js';

// A Pi-process endpoint. Synchronous queue operations serialize parallel tool
// calls on this event loop; no JavaScript awaits inside a publication.
export function createCanvasMessageClient({ config, name, epoch, deliver, onReceipt = () => {}, onError = () => {},
  native = messagingNative(), open = openCanvasMemory, watchdogMs = 1000, now = Date.now, canDeliver = () => true, onResume = () => {} }) {
  if (config?.version !== MESSAGE_VERSION || config.epoch !== epoch) throw messageError('SHM_VERSION', 'Incompatible messaging generation');
  const resources = [], queues = {}, history = new Map();
  let closed = false, paused = false, pauseCode, fenced = false, draining = false, timer, watcher, tx;
  const read = () => { const reader = open(name, epoch); try { return reader.read(); } finally { reader.close(); } };
  const wake = () => {
    try { native.signalPost(tx); return undefined; }
    catch (error) { return error.code ?? 'SHM_SIGNAL'; } // Already queued: never imply safe to resend.
  };
  const remember = status => {
    history.delete(status.messageId); history.set(status.messageId, status);
    while (history.size > 64) history.delete(history.keys().next().value);
  };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer);
    for (const key of ['inbox', 'outbox', 'acks', 'receipts']) queues[key]?.close();
    for (const dispose of resources.reverse()) dispose();
  };
  const pause = error => {
    if (paused) return;
    paused = true; pauseCode = error.code;
    onError(error);
  };
  const fail = error => {
    if (transientMemoryError(error)) pause(error);
    else { fenced = true; clearInterval(timer); onError(error); }
  };
  const drain = () => {
    if (closed || fenced || draining) return;
    draining = true;
    try {
      read(); // Server heartbeat/epoch is authoritative even when hints are lost.
      const resumed = paused; paused = false;
      let changed = false;
      for (let i = 0; i < QUEUE_SLOTS; i++) {
        const entry = queues.receipts.peek(); if (!entry) break;
        const status = entry.value;
        if (!status || !validMessageId(status.messageId) || !['accepted', 'rejected', 'delivered', 'expired', 'unknown'].includes(status.status)) throw messageError('SHM_CORRUPT', 'Invalid message receipt');
        // Duplicate rejection must not replace the original message's evidence.
        if (status.code !== 'MESSAGE_DUPLICATE') { remember(status); onReceipt(status); }
        queues.receipts.shift(entry.sequence); changed = true;
      }
      for (let i = 0; i < QUEUE_SLOTS && canDeliver() && queues.acks.used < QUEUE_SLOTS; i++) {
        const entry = queues.inbox.peek(); if (!entry) break;
        const frame = entry.value;
        if (!frame || frame.serverEpoch !== epoch || frame.agentId !== config.id || frame.generation !== config.generation || !validMessageId(frame.messageId)) throw messageError('SHM_CORRUPT', 'Invalid inbound message generation');
        const { sourceId, sourceGeneration, serverEpoch: _epoch, ...request } = frame;
        if (!validId(sourceId) || !validId(sourceGeneration)) throw messageError('SHM_CORRUPT', 'Invalid message source');
        validateSend(request, now(), true);
        let status = 'delivered';
        if (frame.expiresAt <= now()) status = 'expired';
        else {
          try { deliver(frame); }
          catch { status = 'unknown'; } // Do not retry a possibly partially successful handoff.
        }
        queues.acks.push({ sourceId: frame.sourceId, sourceGeneration: frame.sourceGeneration, messageId: frame.messageId, status });
        queues.inbox.shift(entry.sequence); changed = true;
      }
      if (changed) wake();
      if (resumed) onResume();
    } catch (error) { fail(error); }
    finally { draining = false; }
  };
  try {
    try { read(); } catch (error) { if (!transientMemoryError(error)) throw error; pause(error); }
    for (const [key, producer] of [['outbox', true], ['inbox', false], ['receipts', false], ['acks', true]]) {
      queues[key] = messageQueue(native, native.queueOpen(config[key], producer ? 'producer' : 'consumer'));
      resources.push(() => queues[key].close());
    }
    tx = native.signalOpen(config.tx); resources.push(() => native.signalClose(tx));
    watcher = native.signalWatch(config.rx, drain); resources.push(() => native.signalClose(watcher));
    timer = setInterval(drain, watchdogMs); timer.unref(); drain();
    if (fenced) throw messageError('MESSAGE_CHANNEL_FENCED', 'Message channel unavailable');
  } catch (error) { close(); throw error; }
  return {
    send({ agentId, generation, text, delivery = 'nextTurn', wake: trigger = false, ttlMs = 60000 } = {}) {
      if (closed) throw messageError('SHM_CLOSED', 'Messaging process channel closed; no automatic retry or HTTP fallback');
      if (fenced) throw messageError('MESSAGE_CHANNEL_FENCED', 'Messaging generation fenced; no automatic reconnect');
      let snapshot;
      try { snapshot = read(); } catch (error) { fail(error); throw error; }
      // Inbox/receipt draining stays on the existing watchdog; never resend.
      if (paused) { paused = false; onResume(); }
      const target = snapshot.agents.find(agent => agent.id === agentId);
      if (!target || target.status !== 'running' || !target.processGeneration) throw messageError('MESSAGE_TARGET', 'Target is not running');
      if (agentId === config.id) throw messageError('MESSAGE_SELF', 'Self messaging is not allowed');
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw messageError('MESSAGE_ARGUMENT', 'ttlMs must be 1–600000');
      const frame = { messageId: randomUUID(), agentId, generation: generation ?? target.processGeneration, text, delivery, wake: trigger, expiresAt: now() + ttlMs };
      validateSend(frame, now());
      queues.outbox.push(frame);
      const status = { messageId: frame.messageId, status: 'queued', agentId, generation: frame.generation, expiresAt: frame.expiresAt };
      remember(status);
      const warning = wake();
      return { ...status, ...(warning ? { notificationWarning: warning } : {}) };
    },
    status(messageId) {
      if (!validMessageId(messageId)) throw messageError('MESSAGE_ARGUMENT', 'Invalid message ID');
      const last = history.get(messageId);
      if (!last) return { messageId, status: 'unknown', code: 'MESSAGE_HISTORY_MISSING' };
      if ((closed || fenced || paused) && ['queued', 'accepted'].includes(last.status)) return { ...last, lastKnownStatus: last.status, status: 'unknown', code: closed ? 'MESSAGE_CHANNEL_CLOSED' : fenced ? 'MESSAGE_CHANNEL_FENCED' : pauseCode };
      return { ...last };
    },
    drain, close, get closed() { return closed; }, get paused() { return paused; }, get fenced() { return fenced; },
  };
}
