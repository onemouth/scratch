import { memoryName } from '../shared/canvas-memory.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { TELEMETRY_VERSION, TELEMETRY_SLOTS, telemetryError, validateTelemetry } from '../shared/canvas-telemetry.js';

// Dedicated Pi -> Scratch reports, with one reverse receipt per report. Peer
// messages/acks never compete for these slots. Only Scratch applies mutations.
export function createCanvasTelemetry({ epoch, apply, native = messagingNative(), watchdogMs = 1000, now = Date.now, onError = console.error }) {
  const channels = new Map();
  let closed = false;
  const drain = () => {
    if (closed) return;
    for (const channel of [...channels.values()]) {
      try {
        for (let i = 0; i < TELEMETRY_SLOTS && channel.receipts.used < TELEMETRY_SLOTS; i++) {
          const entry = channel.reports.peek(); if (!entry) break;
          const frame = entry.value;
          const seq = Number.isSafeInteger(frame?.seq) && frame.seq > 0 ? frame.seq : null;
          let status = 'applied', code;
          try {
            validateTelemetry(frame, now());
            if (frame.seq <= channel.lastSeq) throw telemetryError('TELEMETRY_SEQUENCE', 'Old or duplicate report');
            channel.lastSeq = frame.seq;
          } catch (error) {
            status = 'rejected'; code = /^([A-Z0-9_]{1,64})$/.test(error.code ?? '') ? error.code : 'TELEMETRY_REJECTED';
          }
          // Application may have partially committed before throwing: close/fence
          // rather than falsely report a safe-to-retry rejection.
          if (status === 'applied') apply(channel.id, channel.generation, frame);
          // Never claim rejected if application succeeded but publishing a receipt
          // fails. Close the channel; its producer must regard that as unknown.
          if (seq !== null) channel.receipts.push({ seq, status, ...(code ? { code } : {}), at: now() });
          else onError('Canvas rejected malformed telemetry without a valid sequence');
          channel.reports.shift(entry.sequence);
          try { native.signalPost(channel.rx); }
          catch { /* Hints only: the client watchdog reads the receipt queue. */ }
        }
      } catch (error) {
        if (error.code !== 'SHM_CLOSED') onError(`Canvas telemetry channel failed: ${error.code ?? 'TELEMETRY_ERROR'}`);
        channel.close();
      }
    }
  };
  const timer = setInterval(drain, watchdogMs); timer.unref();
  return {
    createChannel(id, generation) {
      if (closed || channels.has(id) || channels.size >= 256) throw telemetryError('TELEMETRY_LIMIT', 'Telemetry process channel limit reached or closed');
      const resources = [], config = { version: TELEMETRY_VERSION, epoch, id, generation };
      const channel = { id, generation, lastSeq: 0, close() {
        if (channels.get(id) !== channel) return;
        channels.delete(id);
        channel.reports.close(); channel.receipts.close();
        for (const dispose of resources.reverse()) dispose();
      } };
      try {
        for (const [key, role, bytes] of [['reports', 'consumer', 16384], ['receipts', 'producer', 1024]]) {
          config[key] = memoryName();
          channel[key] = messageQueue(native, native.queueCreate(config[key], role, bytes));
          resources.push(() => channel[key].close());
        }
        config.tx = memoryName(); config.rx = memoryName();
        const tx = native.signalCreate(config.tx); resources.push(() => native.signalClose(tx));
        channel.rx = native.signalCreate(config.rx); resources.push(() => native.signalClose(channel.rx));
        const watcher = native.signalWatch(config.tx, drain); resources.push(() => native.signalClose(watcher));
        channel.config = config; channels.set(id, channel); return channel;
      } catch (error) { for (const dispose of resources.reverse()) dispose(); throw error; }
    },
    drain,
    close() { if (!closed) { closed = true; clearInterval(timer); for (const channel of [...channels.values()]) channel.close(); } },
    get size() { return channels.size; },
  };
}
