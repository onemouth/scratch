import { createCanvasTelemetryClient } from './canvas-telemetry-client.js';
import { telemetryError } from '../shared/canvas-telemetry.js';
import { bindCanvasStatus, detachCanvasStatus, setCanvasStatus } from './pi-canvas-status.js';

const KEY = Symbol.for('agent-canvas.telemetry.process.v1');
export const warnTelemetry = (broker, code, receiptSeq = null) => {
  broker.error = code; broker.receiptProblem = receiptSeq;
  setCanvasStatus('telemetry', broker.binding?.owner, { code });
};
// Like messaging, this owner survives replacement extension instances. The
// registry holds lifecycle ownership only; SHM reports use actual POSIX queues.
export function bindTelemetryProcess({ config, name, epoch, id, ctx, owner, snapshot }) {
  bindCanvasStatus('telemetry', owner, ctx);
  if (config?.id !== id) throw telemetryError('SHM_VERSION', 'Telemetry identity mismatch');
  const fingerprint = JSON.stringify({ config, name, epoch, id });
  let broker = process[KEY];
  if (broker && broker.fingerprint !== fingerprint) throw telemetryError('SHM_VERSION', 'Cannot follow a replacement telemetry process');
  if (!broker) {
    broker = { fingerprint, binding: null, client: null, error: null, closed: false, refreshPending: false,
      close() {
        if (broker.closed) return;
        broker.closed = true; detachCanvasStatus('telemetry', broker.binding?.owner); broker.binding = null; broker.client?.close();
        process.removeListener('exit', broker.close);
        if (process[KEY] === broker) delete process[KEY];
      },
      publish(kind, data) {
        if (broker.closed) throw telemetryError('SHM_CLOSED', 'Telemetry process closed');
        return broker.client.send(kind, data);
      },
    };
    broker.client = createCanvasTelemetryClient({ config, name, epoch,
      onError: error => warnTelemetry(broker, error.code ?? 'TELEMETRY_ERROR'),
      onReceipt: receipt => {
        if (receipt.status !== 'applied') warnTelemetry(broker, receipt.code ?? 'TELEMETRY_REJECTED', receipt.seq);
        else if (Number.isSafeInteger(broker.receiptProblem) && receipt.seq > broker.receiptProblem && !broker.client?.paused && !broker.client?.fenced) {
          // A fresh applied report supersedes an old receipt warning, not its evidence.
          broker.error = null; broker.receiptProblem = null;
          setCanvasStatus('telemetry', broker.binding?.owner);
        }
      },
      onReady: ({ resumed }) => {
        if (resumed) {
          broker.refreshPending = true; broker.error = null; broker.receiptProblem = null;
          setCanvasStatus('telemetry', broker.binding?.owner);
        }
        if (!broker.refreshPending || !broker.binding?.snapshot) return;
        try {
          if (broker.client.available < 2) return;
          // Read the CURRENT binding at recovery time, not cached pre-sleep data.
          // If backpressured, a later watchdog takes another fresh snapshot.
          const current = broker.binding.snapshot();
          broker.publish('session', current.session);
          broker.publish('activity', current.activity);
          broker.refreshPending = false;
        } catch (error) { warnTelemetry(broker, error.code ?? 'TELEMETRY_ERROR'); }
      },
    });
    process[KEY] = broker; process.once('exit', broker.close);
  }
  broker.binding = { ctx, owner, snapshot };
  // session_start publishes a fresh pair itself, including after detached recovery.
  broker.refreshPending = false;
  setCanvasStatus('telemetry', owner, broker.error ? { code: broker.error } : undefined);
  return broker;
}
export function detachTelemetryProcess(broker, owner, reason) {
  if (!broker || broker.binding?.owner !== owner) return;
  detachCanvasStatus('telemetry', owner);
  broker.binding = null;
  if (reason === 'quit') broker.close();
}
