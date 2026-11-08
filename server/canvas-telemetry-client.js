import { openCanvasMemory } from '../shared/canvas-memory.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { TELEMETRY_VERSION, TELEMETRY_SLOTS, TELEMETRY_TTL, telemetryError, validateTelemetry, validateTelemetryConfig } from '../shared/canvas-telemetry.js';

export function createCanvasTelemetryClient({ config, name, epoch, onReceipt = () => {}, onError = () => {},
  native = messagingNative(), open = openCanvasMemory, watchdogMs = 1000, now = Date.now, onReady = () => {} }) {
  validateTelemetryConfig(config, epoch);
  const resources = [], queues = {}, history = new Map(), pending = new Map();
  let closed = false, paused = false, draining = false, seq = 0, timer, tx;
  const read = () => { const reader = open(name, epoch); try { reader.read(); } finally { reader.close(); } };
  const remember = status => {
    history.delete(status.seq); history.set(status.seq, status);
    while (history.size > 64) history.delete(history.keys().next().value);
  };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer);
    for (const dispose of resources.reverse()) dispose();
  };
  const pause = error => {
    if (paused) return;
    paused = true;
    // Publication may already have happened. Retain queues/credits and accept
    // later receipt evidence, but never replay these uncertain reports.
    for (const seq of pending.keys()) remember({ seq, status: 'unknown', code: 'SHM_STALE' });
    onError(error);
  };
  const drain = () => {
    if (closed || draining) return;
    draining = true;
    try {
      read(); // Validates the original name AND epoch before resuming any writes.
      const resumed = paused;
      paused = false;
      for (let i = 0; i < TELEMETRY_SLOTS; i++) {
        const entry = queues.receipts.peek(); if (!entry) break;
        const status = entry.value;
        if (!status || !Number.isSafeInteger(status.seq) || status.seq < 1 || !['applied', 'rejected'].includes(status.status) ||
            !Number.isSafeInteger(status.at) || (status.code !== undefined && !/^[A-Z0-9_]{1,64}$/.test(status.code))) {
          throw telemetryError('SHM_CORRUPT', 'Invalid telemetry receipt');
        }
        // A duplicate frame must not replace the original report's evidence.
        if (status.code !== 'TELEMETRY_SEQUENCE') { remember(status); pending.delete(status.seq); onReceipt(status); }
        queues.receipts.shift(entry.sequence);
        try { native.signalPost(tx); } catch { /* Watchdog recovers lost hints. */ }
      }
      for (const [seq, expiresAt] of pending) if (expiresAt <= now()) {
        const status = { seq, status: 'unknown', code: 'TELEMETRY_ACK_TIMEOUT' };
        pending.delete(seq); remember(status); onReceipt(status);
      }
      onReady({ resumed });
    } catch (error) {
      if (error.code === 'SHM_STALE') pause(error);
      else { close(); onError(error); }
    } finally { draining = false; }
  };
  try {
    try { read(); } catch (error) {
      if (error.code !== 'SHM_STALE') throw error;
      pause(error);
    }
    for (const [key, role] of [['reports', 'producer'], ['receipts', 'consumer']]) {
      queues[key] = messageQueue(native, native.queueOpen(config[key], role));
      resources.push(() => queues[key].close());
    }
    tx = native.signalOpen(config.tx); resources.push(() => native.signalClose(tx));
    const watcher = native.signalWatch(config.rx, drain); resources.push(() => native.signalClose(watcher));
    timer = setInterval(drain, watchdogMs); timer.unref(); drain();
    if (closed) throw telemetryError('SHM_CLOSED', 'Telemetry channel unavailable');
  } catch (error) { close(); throw error; }
  return {
    send(kind, data) {
      drain();
      if (closed) throw telemetryError('SHM_CLOSED', 'Telemetry process channel closed; no HTTP fallback or automatic resend');
      if (paused) throw telemetryError('SHM_STALE', 'Telemetry paused until the original server heartbeat recovers; report not queued');
      if (pending.size >= TELEMETRY_SLOTS) throw telemetryError('TELEMETRY_LIMIT', 'Telemetry receipt window full');
      const frame = { version: TELEMETRY_VERSION, seq: seq + 1, kind, data, expiresAt: now() + TELEMETRY_TTL };
      validateTelemetry(frame, now());
      queues.reports.push(frame); // No awaits; parallel tools share this event loop.
      seq = frame.seq; pending.set(seq, frame.expiresAt);
      const status = { seq, status: 'queued', kind }; remember(status);
      try { native.signalPost(tx); return status; }
      catch { return { ...status, notificationWarning: 'SHM_SIGNAL' }; } // Already committed.
    },
    status(seq) {
      const last = history.get(seq);
      if (!last) return { seq, status: 'unknown', code: 'TELEMETRY_HISTORY_MISSING' };
      if (closed && last.status === 'queued') return { ...last, status: 'unknown', code: 'TELEMETRY_CHANNEL_CLOSED' };
      return { ...last };
    },
    // Recovery snapshots need two report credits; do not partially refresh on
    // every watchdog tick while old reports are still blocking the queue.
    get available() { return closed || paused ? 0 : Math.min(TELEMETRY_SLOTS - pending.size, TELEMETRY_SLOTS - queues.reports.used); },
    drain, close, get closed() { return closed; }, get paused() { return paused; },
  };
}
