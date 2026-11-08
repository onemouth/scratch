import { memoryName } from '../shared/canvas-memory.js';
import { messagingNative, messageQueue } from '../shared/canvas-messages.js';
import { QUERY_VERSION, QUERY_SLOTS, queryError, queryFits, validateQueryFrame } from '../shared/canvas-queries.js';

// Read-only, allowlisted request/response queues. No HTTP tunnel or mutations.
// A response credit is reserved before reading/evaluating each request.
export function createCanvasQueries({ epoch, execute, native = messagingNative(), watchdogMs = 1000, now = Date.now, onError = console.error }) {
  if (native.queueMaxBytes !== 65536) throw queryError('SHM_VERSION', 'Canvas native addon is outdated; run npm run build:shm');
  const channels = new Map();
  let closed = false;
  const drain = () => {
    if (closed) return;
    for (const channel of [...channels.values()]) {
      try {
        for (let i = 0; i < QUERY_SLOTS && channel.responses.used < QUERY_SLOTS; i++) {
          const entry = channel.requests.peek(); if (!entry) break;
          const frame = entry.value;
          let response = { version: QUERY_VERSION, seq: frame?.seq, ok: true };
          try {
            if (!Number.isSafeInteger(frame?.seq) || frame.seq < 1 || frame.seq <= channel.lastSeq) throw queryError('QUERY_SEQUENCE', 'Invalid or old request sequence');
            channel.lastSeq = frame.seq;
            validateQueryFrame(frame, now());
            const value = execute(channel.id, channel.generation, frame.kind, frame.params);
            response.value = { ...value, source: 'posix-shared-memory', serverEpoch: epoch, sampledAt: new Date(now()).toISOString() };
            if (!queryFits(response)) throw queryError('QUERY_CAPACITY', 'Query result exceeds the response byte limit');
          } catch (error) {
            response = { version: QUERY_VERSION, seq: frame?.seq, ok: false, error: {
              code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : error.status === 404 ? 'QUERY_NOT_FOUND' : 'QUERY_FAILED',
              message: String(error.message ?? 'Query failed').slice(0, 240),
            } };
          }
          // Malformed frames cannot correlate to any valid caller. Consume once.
          if (Number.isSafeInteger(frame?.seq) && frame.seq > 0) channel.responses.push(response);
          channel.requests.shift(entry.sequence);
          try { native.signalPost(channel.rx); } catch { /* Hints only. */ }
        }
      } catch (error) {
        if (error.code !== 'SHM_CLOSED') onError(`Canvas query channel failed: ${error.code ?? 'QUERY_ERROR'}`);
        channel.close();
      }
    }
  };
  const timer = setInterval(drain, watchdogMs); timer.unref();
  return {
    createChannel(id, generation) {
      if (closed || channels.has(id) || channels.size >= 256) throw queryError('QUERY_LIMIT', 'Query process channel limit reached or closed');
      const resources = [], config = { version: QUERY_VERSION, epoch, id, generation };
      const channel = { id, generation, lastSeq: 0, close() {
        if (channels.get(id) !== channel) return;
        channels.delete(id);
        for (const dispose of resources.reverse()) dispose();
      } };
      try {
        for (const [key, role, bytes] of [['requests', 'consumer', 1024], ['responses', 'producer', 65536]]) {
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
