import { inboxMessageContent } from '../shared/canvas-inbox.js';
import { transientMemoryError } from '../shared/canvas-memory.js';
import { createCanvasMessageClient } from './canvas-message-client.js';
import { MESSAGE_VERSION, messageError } from '../shared/canvas-messages.js';

// Pi replaces extension module instances on reload/new/resume/fork. The process
// owns transport resources, not those instances. Never retain a detached Pi API
// or ExtensionContext in transport callbacks; only this replaceable binding.
const KEY = Symbol.for('agent-canvas.messaging.process.v1');
const notify = (ctx, text, level) => { try { if (ctx?.hasUI) ctx.ui.notify(text, level); } catch { /* UI never owns channel lifetime. */ } };
export function bindMessageProcess({ config, name, epoch, pi, ctx, owner }) {
  if (config.version !== MESSAGE_VERSION || config.epoch !== epoch) throw messageError('SHM_VERSION', 'Incompatible messaging generation');
  const fingerprint = JSON.stringify({ config, name, epoch });
  let broker = process[KEY];
  if (broker && broker.fingerprint !== fingerprint) throw messageError('SHM_VERSION', 'Cannot follow a replacement messaging generation inside this process');
  if (!broker) {
    broker = { fingerprint, binding: null, client: null, error: null, closed: false, close() {
      if (broker.closed) return;
      broker.closed = true; broker.binding = null; broker.client?.close();
      process.removeListener('exit', broker.close);
      if (process[KEY] === broker) delete process[KEY];
    } };
    broker.client = createCanvasMessageClient({ config, name, epoch,
      canDeliver: () => Boolean(broker.binding),
      deliver: frame => {
        const binding = broker.binding;
        if (!binding) throw messageError('MESSAGE_CONTEXT', 'No current Pi context');
        binding.pi.sendMessage({ customType: 'canvas-agent-message',
          content: inboxMessageContent(frame), display: true,
          details: { messageId: frame.messageId, sourceId: frame.sourceId, sourceGeneration: frame.sourceGeneration } },
        { deliverAs: frame.delivery, triggerTurn: frame.delivery === 'followUp' && frame.wake });
      },
      onResume: () => {
        broker.error = null;
        const ctx = broker.binding?.ctx;
        notify(ctx, 'Canvas messaging recovered on the same server epoch; no messages resent.', 'info');
      },
      onReceipt: status => {
        const ctx = broker.binding?.ctx;
        notify(ctx, `Canvas message ${status.messageId}: ${status.status}${status.code ? ` (${status.code})` : ''}`, 'info');
      },
      onError: error => {
        broker.error = error;
        const ctx = broker.binding?.ctx;
        notify(ctx, `Canvas messaging ${transientMemoryError(error) ? 'paused until the original publisher recovers' : 'fenced'}: ${error.code ?? 'MESSAGE_ERROR'}. No retry or HTTP fallback.`, 'warning');
      },
    });
    process[KEY] = broker;
    process.once('exit', broker.close);
  }
  broker.binding = { pi, ctx, owner };
  broker.client.drain(); // Recheck work queued during the context handoff.
  if (broker.error) notify(ctx, `Canvas messaging unavailable: ${broker.error.code ?? 'MESSAGE_ERROR'}.`, 'warning');
  return broker;
}

export function detachMessageProcess(broker, owner, reason) {
  if (!broker || broker.binding?.owner !== owner) return; // Ignore stale runtime cleanup.
  broker.binding = null;
  broker.client.resetInboxContext?.(); // Older process-owned brokers remain valid until explicit relaunch.
  if (reason === 'quit') broker.close();
}
