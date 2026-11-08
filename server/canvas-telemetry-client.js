import { openCanvasMemory } from '../shared/canvas-memory.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { TELEMETRY_VERSION, TELEMETRY_SLOTS, TELEMETRY_TTL, telemetryError, validateTelemetry, validateTelemetryConfig } from '../shared/canvas-telemetry.js';

export function createCanvasTelemetryClient({ config, name, epoch, onReceipt = () => {}, onError = () => {},
  native = messagingNative(), open = openCanvasMemory, watchdogMs = 1000, now = Date.now }) {
  validateTelemetryConfig(config, epoch);
  const resources = [], queues = {}, history = new Map(), pending = new Map();
  let closed = false, seq = 0, timer, tx;
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
  const drain = () => {
    if (closed) return;
    try {
      read();
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
    } catch (error) { close(); onError(error); }
  };
  try {
    read();
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
    drain, close, get closed() { return closed; },
  };
}
