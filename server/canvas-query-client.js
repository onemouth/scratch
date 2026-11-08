import { openCanvasMemory, transientMemoryError } from '../shared/canvas-memory.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { QUERY_VERSION, QUERY_SLOTS, QUERY_TTL, queryError, queryFits, validateQuery, validateQueryConfig } from '../shared/canvas-queries.js';

export function createCanvasQueryClient({ config, name, epoch, native = messagingNative(), open = openCanvasMemory,
  watchdogMs = 250, timeoutMs = QUERY_TTL, now = Date.now }) {
  validateQueryConfig(config, epoch);
  if (native.queueMaxBytes !== 65536) throw queryError('SHM_VERSION', 'Canvas native addon is outdated; run npm run build:shm');
  const resources = [], queues = {}, pending = new Map();
  let seq = 0, timer, closed = false, fenced = false, draining = false;
  const read = () => { const reader = open(name, epoch); try { reader.read(); } finally { reader.close(); } };
  const cancel = (error = queryError('QUERY_CONTEXT', 'Query context detached')) => {
    for (const job of [...pending.values()]) job.finish(error);
  };
  const fail = error => {
    cancel(error);
    if (!transientMemoryError(error)) { fenced = true; clearInterval(timer); }
    // Retain native handles until process cleanup; never reopen or resend.
  };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); cancel(queryError('SHM_CLOSED', 'Query process closed'));
    for (const dispose of resources.reverse()) dispose();
  };
  const drain = () => {
    if (closed || fenced || draining) return;
    draining = true;
    try {
      read();
      let changed = false;
      for (let i = 0; i < QUERY_SLOTS; i++) {
        const entry = queues.responses.peek(); if (!entry) break;
        const frame = entry.value;
        if (!frame || frame.version !== QUERY_VERSION || !Number.isSafeInteger(frame.seq) || frame.seq < 1 ||
          typeof frame.ok !== 'boolean' || (frame.ok ? !frame.value || !queryFits(frame) || frame.value.serverEpoch !== epoch ||
            frame.value.source !== 'posix-shared-memory' || typeof frame.value.sampledAt !== 'string' || !Number.isFinite(Date.parse(frame.value.sampledAt))
            : !/^[A-Z0-9_]{1,64}$/.test(frame.error?.code ?? '') || typeof frame.error.message !== 'string' || frame.error.message.length > 240)) {
          throw queryError('QUERY_PROTOCOL', 'Malformed query response');
        }
        queues.responses.shift(entry.sequence); changed = true;
        const job = pending.get(frame.seq);
        job?.finish(frame.ok ? null : queryError(frame.error.code, frame.error.message), frame.value);
      }
      if (changed) try { native.signalPost(tx); } catch { /* Watchdog also drains. */ }
    } catch (error) { fail(error); }
    finally { draining = false; }
  };
  let tx;
  try {
    try { read(); } catch (error) { if (!transientMemoryError(error)) throw error; }
    for (const [key, role] of [['requests', 'producer'], ['responses', 'consumer']]) {
      queues[key] = messageQueue(native, native.queueOpen(config[key], role));
      resources.push(() => queues[key].close());
    }
    tx = native.signalOpen(config.tx); resources.push(() => native.signalClose(tx));
    const watcher = native.signalWatch(config.rx, drain); resources.push(() => native.signalClose(watcher));
    timer = setInterval(drain, watchdogMs); timer.unref();
  } catch (error) { close(); throw error; }
  return {
    async query(kind, params = {}, signal) {
      signal?.throwIfAborted();
      if (closed || fenced) throw queryError(closed ? 'SHM_CLOSED' : 'QUERY_FENCED', 'Query channel unavailable; no reconnect or HTTP fallback');
      validateQuery(kind, params);
      try { read(); } catch (error) { fail(error); throw error; }
      if (pending.size >= QUERY_SLOTS) throw queryError('QUERY_LIMIT', 'Too many outstanding queries');
      return new Promise((resolve, reject) => {
        const sequence = ++seq;
        let deadline;
        const abort = () => finish(queryError('QUERY_ABORTED', 'Query cancelled; no resend'));
        const finish = (error, value) => {
          if (!pending.delete(sequence)) return;
          clearTimeout(deadline); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(value);
        };
        pending.set(sequence, { finish });
        signal?.addEventListener('abort', abort, { once: true });
        deadline = setTimeout(() => finish(queryError('QUERY_TIMEOUT', 'Query timed out; no resend')), timeoutMs);
        try {
          queues.requests.push({ version: QUERY_VERSION, seq: sequence, kind, params, expiresAt: now() + QUERY_TTL });
          try { native.signalPost(tx); } catch { /* Already queued; never republish. */ }
        } catch (error) {
          if (error.code !== 'SHM_QUEUE_FULL' && !transientMemoryError(error)) fail(error);
          finish(error);
        }
      });
    },
    drain, cancel, close, get closed() { return closed; }, get fenced() { return fenced; }, get pending() { return pending.size; },
  };
}
