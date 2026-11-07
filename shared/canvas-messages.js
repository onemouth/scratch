import { nativeMemory } from './canvas-memory.js';

export const MESSAGE_VERSION = 1;
export const QUEUE_SLOTS = 16;
export const MAX_TEXT_BYTES = 8000;
export const MAX_TTL_MS = 600000;
export const messageError = (code, text) => Object.assign(new Error(text), { code });
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
export const validMessageId = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const validText = text => typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= MAX_TEXT_BYTES && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text);
export function validateSend(frame, now = Date.now(), allowExpired = false) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
      Object.keys(frame).some(key => !['messageId', 'agentId', 'generation', 'text', 'delivery', 'wake', 'expiresAt'].includes(key)) ||
      !validMessageId(frame.messageId) || !validId(frame.agentId) || !validId(frame.generation) || !validText(frame.text) ||
      !['nextTurn', 'followUp'].includes(frame.delivery) || typeof frame.wake !== 'boolean' ||
      (frame.wake && frame.delivery !== 'followUp') || !Number.isSafeInteger(frame.expiresAt) || frame.expiresAt > now + MAX_TTL_MS) {
    throw messageError('MESSAGE_ARGUMENT', 'Invalid message, delivery policy or deadline');
  }
  if (!allowExpired && frame.expiresAt <= now) throw messageError('MESSAGE_EXPIRED', 'Message expired before acceptance');
}
export function messagingNative() {
  const native = nativeMemory();
  if (!['queueCreate', 'queueOpen', 'queuePush', 'queuePeek', 'queueShift', 'queueState', 'queueClose', 'signalOpen'].every(key => typeof native[key] === 'function')) {
    throw messageError('SHM_VERSION', 'Canvas native addon is outdated; run npm run build:shm');
  }
  return native;
}
// Native handles never expose mapped pointers or writable snapshot buffers.
export function messageQueue(native, handle) {
  return {
    push(value) { return native.queuePush(handle, Buffer.from(JSON.stringify(value))); },
    peek() {
      const entry = native.queuePeek(handle);
      if (!entry) return null;
      // Keep sequence even on malformed JSON so the consumer can reject/skip it.
      try { return { sequence: entry.sequence, value: JSON.parse(entry.payload.toString('utf8')) }; }
      catch { return { sequence: entry.sequence, value: null }; }
    },
    shift(sequence) { native.queueShift(handle, sequence); },
    get used() { return native.queueState(handle).used; },
    close() { native.queueClose(handle); },
  };
}
