import { memoryName } from '../shared/canvas-memory.js';
import { INBOX_VERSION } from '../shared/canvas-inbox.js';
import { createAgentInbox } from './agent-inbox.js';
import { MESSAGE_VERSION, QUEUE_SLOTS, messagingNative, messageQueue, validateSend, validId, validMessageId, messageError } from '../shared/canvas-messages.js';

// Scratch mediates every message. Independent SPSC queues avoid shared writers;
// reserved receipt credits ensure that every accepted message can be resolved.
export function createCanvasMessaging({ epoch, getAgent, onChange = () => {}, onError = console.error, native = messagingNative(), watchdogMs = 1000, now = Date.now }) {
  const channels = new Map();
  const inbox = createAgentInbox({ getAgent, onChange, now });
  let closed = false;
  const post = channel => {
    try { native.signalPost(channel.rx); }
    catch (error) { onError(`Canvas message wake unavailable: ${error.code ?? 'SHM_SIGNAL'}`); }
  };
  const receipt = (source, messageId, status, code) => {
    source.receipts.push({ messageId, status, ...(code ? { code } : {}), at: now() }); post(source);
  };
  const finish = (source, messageId, status, code) => {
    const pending = source.pending.get(messageId);
    if (pending) inbox.handoff(pending.target.id, pending.target.generation, messageId, status);
    receipt(source, messageId, status, code); source.pending.delete(messageId);
  };
  const current = channel => {
    const agent = getAgent(channel.id);
    return agent?.status === 'running' && agent.processGeneration === channel.generation;
  };
  const drainAcks = target => {
    for (let i = 0; i < QUEUE_SLOTS; i++) {
      const entry = target.acks.peek(); if (!entry) break;
      const ack = entry.value;
      if (ack?.kind === 'inbox') inbox.observe(target.id, target.generation, ack);
      else if (ack && validId(ack.sourceId) && validMessageId(ack.messageId) && validId(ack.sourceGeneration) && ['delivered', 'unknown', 'expired'].includes(ack.status)) {
        // Late receiver evidence can resolve the UI even after source closure
        // or ACK_TIMEOUT; it must never manufacture a new sender receipt.
        inbox.handoff(target.id, target.generation, ack.messageId, ack.status, ack.sourceId, ack.sourceGeneration);
        const source = channels.get(ack.sourceId), pending = source?.pending.get(ack.messageId);
        if (pending?.target === target && pending.sourceGeneration === source.generation && ack.sourceGeneration === source.generation) finish(source, ack.messageId, ack.status);
      }
      target.acks.shift(entry.sequence);
    }
  };
  const drainOutbox = source => {
    if (!current(source)) return;
    for (let i = 0; i < QUEUE_SLOTS; i++) {
      // One receipt now, one reserved for terminal delivery/timeout/closure.
      if (source.receipts.used + source.pending.size > QUEUE_SLOTS - 2) break;
      const entry = source.outbox.peek(); if (!entry) break;
      const frame = entry.value;
      const id = validMessageId(frame?.messageId) ? frame.messageId : null;
      let committed = false;
      try {
        validateSend(frame, now());
        if (source.id === frame.agentId) throw messageError('MESSAGE_SELF', 'Self messaging is not allowed');
        for (const [id, deadline] of source.seen) if (deadline < now()) source.seen.delete(id);
        if (source.seen.has(id)) throw messageError('MESSAGE_DUPLICATE', 'Duplicate message ID; not resent');
        if (source.seen.size >= 512) throw messageError('MESSAGE_LIMIT', 'Message ID history full');
        source.rate = source.rate.filter(time => time > now() - 60000);
        source.wakes = source.wakes.filter(time => time > now() - 60000);
        if (source.rate.length >= 30 || (frame.delivery === 'followUp' && source.wakes.length >= 3)) throw messageError('MESSAGE_RATE', 'Message/follow-up rate limit');
        const target = channels.get(frame.agentId);
        if (!target || !current(target) || target.generation !== frame.generation) throw messageError('MESSAGE_TARGET', 'Target unavailable or process generation changed');
        target.incomingFollowUps = target.incomingFollowUps.filter(time => time > now() - 60000);
        if (frame.delivery === 'followUp' && (source.followUpCount >= 16 || target.followUpCountReceived >= 16 || target.incomingFollowUps.length >= 3)) {
          throw messageError('MESSAGE_RATE', 'Follow-up rate or process lifetime budget reached');
        }
        if (!inbox.capacity(target.id, target.generation)) throw messageError('MESSAGE_INBOX_FULL', 'Target pending inbox capacity reached');
        if (target.inbox.used >= QUEUE_SLOTS) throw messageError('SHM_QUEUE_FULL', 'Target mailbox full');
        source.rate.push(now());
        if (frame.delivery === 'followUp') {
          source.wakes.push(now()); source.followUpCount++;
          target.incomingFollowUps.push(now()); target.followUpCountReceived++;
        }
        source.seen.set(id, now() + 660000);
        target.inbox.push({ ...frame, sourceId: source.id, sourceGeneration: source.generation, serverEpoch: epoch });
        committed = true;
        inbox.add(target.id, target.generation, { ...frame, sourceId: source.id, sourceGeneration: source.generation });
        source.pending.set(id, { target, sourceGeneration: source.generation, expiresAt: frame.expiresAt });
        receipt(source, id, 'accepted'); post(target);
      } catch (error) {
        if (committed) throw error; // Uncertain after enqueue: never report rejected/safe to retry.
        if (id) receipt(source, id, 'rejected', error.code ?? 'MESSAGE_ERROR');
        else onError('Canvas rejected malformed message without a valid message ID');
      }
      source.outbox.shift(entry.sequence);
    }
  };
  const drain = () => {
    if (closed) return;
    inbox.prune();
    // Ack queues are independent: full outboxes cannot deadlock delivery acks.
    for (const channel of [...channels.values()]) {
      try { drainAcks(channel); }
      catch (error) { if (error.code !== 'SHM_CLOSED') onError(`Canvas message channel failed: ${error.code ?? 'MESSAGE_ERROR'}`); channel.close(); }
    }
    for (const channel of [...channels.values()]) {
      try {
        for (const [id, pending] of channel.pending) if (pending.expiresAt <= now()) finish(channel, id, 'unknown', 'MESSAGE_ACK_TIMEOUT');
        drainOutbox(channel);
      } catch (error) { if (error.code !== 'SHM_CLOSED') onError(`Canvas message channel failed: ${error.code ?? 'MESSAGE_ERROR'}`); channel.close(); }
    }
  };
  const timer = setInterval(drain, watchdogMs); timer.unref();
  return {
    inbox,
    createChannel(id, generation) {
      if (closed || channels.has(id) || channels.size >= 256) throw messageError('MESSAGE_LIMIT', 'Messaging closed or process channel limit reached');
      const resources = [], config = { version: MESSAGE_VERSION, inboxVersion: INBOX_VERSION, epoch, id, generation };
      const channel = { id, generation, pending: new Map(), seen: new Map(), rate: [], wakes: [], incomingFollowUps: [], followUpCount: 0, followUpCountReceived: 0, close() {
        if (channels.get(id) !== channel) return;
        channels.delete(id);
        try { drainAcks(channel); } catch { /* Closure remains uncertain if acks cannot be read. */ }
        for (const source of channels.values()) {
          for (const [messageId, pending] of source.pending) if (pending.target === channel) {
            try { finish(source, messageId, 'unknown', 'MESSAGE_TARGET_CLOSED'); }
            catch (error) { onError(`Canvas message receipt failed: ${error.code ?? 'MESSAGE_ERROR'}`); }
          }
        }
        inbox.close(id, generation);
        // Fence data before semaphore close wakes the peer.
        for (const key of ['inbox', 'outbox', 'receipts', 'acks']) channel[key].close();
        for (const dispose of resources.reverse()) dispose();
      } };
      try {
        for (const [key, producer, bytes] of [['outbox', false, 16384], ['inbox', true, 16384], ['receipts', true, 1024], ['acks', false, 1024]]) {
          const name = config[key] = memoryName();
          channel[key] = messageQueue(native, native.queueCreate(name, producer ? 'producer' : 'consumer', bytes));
          resources.push(() => channel[key].close());
        }
        config.tx = memoryName(); config.rx = memoryName();
        const tx = native.signalCreate(config.tx); resources.push(() => native.signalClose(tx));
        channel.rx = native.signalCreate(config.rx); resources.push(() => native.signalClose(channel.rx));
        const watcher = native.signalWatch(config.tx, drain); resources.push(() => native.signalClose(watcher));
        channel.config = config; channels.set(id, channel); inbox.open(id, generation); return channel;
      } catch (error) { for (const dispose of resources.reverse()) dispose(); throw error; }
    },
    drain,
    close() { if (!closed) { closed = true; clearInterval(timer); for (const channel of [...channels.values()]) channel.close(); } },
    get size() { return channels.size; },
  };
}
