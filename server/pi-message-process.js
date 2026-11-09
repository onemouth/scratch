import { inboxMessageContent } from '../shared/canvas-inbox.js';
import { bindCanvasStatus, detachCanvasStatus, setCanvasStatus } from './pi-canvas-status.js';
import { createCanvasMessageClient } from './canvas-message-client.js';
import { MESSAGE_VERSION, messageError } from '../shared/canvas-messages.js';

// Pi replaces extension module instances on reload/new/resume/fork. The process
// owns transport resources, not those instances. Never retain a detached Pi API
// or ExtensionContext in transport callbacks; only this replaceable binding.
const KEY = Symbol.for('agent-canvas.messaging.process.v1');
const notify = (ctx, text, level) => { try { if (ctx?.hasUI) ctx.ui.notify(text, level); } catch { /* UI never owns channel lifetime. */ } };
export function bindMessageProcess({ config, name, epoch, pi, ctx, owner }) {
  bindCanvasStatus('messaging', owner, ctx);
  if (config.version !== MESSAGE_VERSION || config.epoch !== epoch) throw messageError('SHM_VERSION', 'Incompatible messaging generation');
  const fingerprint = JSON.stringify({ config, name, epoch });
  let broker = process[KEY];
  if (broker && broker.fingerprint !== fingerprint) throw messageError('SHM_VERSION', 'Cannot follow a replacement messaging generation inside this process');
  if (!broker) {
    broker = { fingerprint, binding: null, client: null, error: null, closed: false, close() {
      if (broker.closed) return;
      broker.closed = true; detachCanvasStatus('messaging', broker.binding?.owner); broker.binding = null; broker.client?.close();
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
        setCanvasStatus('messaging', broker.binding?.owner);
      },
      onReceipt: status => {
        const ctx = broker.binding?.ctx;
        notify(ctx, `Canvas message ${status.messageId}: ${status.status}${status.code ? ` (${status.code})` : ''}`, 'info');
      },
      onError: error => {
        broker.error = error;
        setCanvasStatus('messaging', broker.binding?.owner, error);
      },
    });
    process[KEY] = broker;
    process.once('exit', broker.close);
  }
  broker.binding = { pi, ctx, owner };
  broker.client.drain(); // Recheck work queued during the context handoff.
  setCanvasStatus('messaging', owner, broker.error);
  return broker;
}

export function detachMessageProcess(broker, owner, reason) {
  if (!broker || broker.binding?.owner !== owner) return; // Ignore stale runtime cleanup.
  detachCanvasStatus('messaging', owner);
  broker.binding = null;
  broker.client.resetInboxContext?.(); // Older process-owned brokers remain valid until explicit relaunch.
  if (reason === 'quit') broker.close();
}
