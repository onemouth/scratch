import { createCanvasTelemetryClient } from './canvas-telemetry-client.js';
import { telemetryError, validateTelemetryData } from '../shared/canvas-telemetry.js';

const KEY = Symbol.for('agent-canvas.telemetry.process.v1');
export const warnTelemetry = (broker, code) => {
  broker.error = code;
  if (broker.warned === code) return;
  const ctx = broker.binding?.ctx;
  if (ctx?.hasUI) {
    broker.warned = code;
    try { ctx.ui.notify(`Canvas telemetry unavailable: ${code}. No automatic resend or transport fallback; session restore/status may be outdated.`, 'warning'); } catch { /* Never block Pi. */ }
  }
};
// Like messaging, this owner survives replacement extension instances. The
// registry holds lifecycle ownership only; SHM reports use actual POSIX queues.
export function bindTelemetryProcess({ mode, config, name, epoch, base, id, runToken, ctx, owner }) {
  if (!['shm', 'http'].includes(mode)) throw telemetryError('TELEMETRY_ARGUMENT', 'Unknown telemetry transport');
  if (mode === 'shm' && config?.id !== id) throw telemetryError('SHM_VERSION', 'Telemetry identity mismatch');
  const fingerprint = JSON.stringify({ mode, config, name, epoch, base, id, runToken });
  let broker = process[KEY];
  if (broker && broker.fingerprint !== fingerprint) throw telemetryError('SHM_VERSION', 'Cannot follow a replacement telemetry process');
  if (!broker) {
    broker = { fingerprint, binding: null, client: null, seq: 0, requests: new Set(), error: null, warned: null, closed: false,
      close() {
        if (broker.closed) return;
        broker.closed = true; broker.binding = null; broker.client?.close();
        for (const controller of broker.requests) controller.abort();
        process.removeListener('exit', broker.close);
        if (process[KEY] === broker) delete process[KEY];
      },
      publish(kind, data) {
        if (broker.closed) throw telemetryError('SHM_CLOSED', 'Telemetry process closed');
        if (mode === 'shm') return broker.client.send(kind, data);
        validateTelemetryData(kind, data);
        if (!['activity', 'session'].includes(kind)) throw telemetryError('TELEMETRY_ARGUMENT', 'HTTP progress uses the existing agent PATCH API');
        if (broker.requests.size >= 16) throw telemetryError('TELEMETRY_LIMIT', 'HTTP telemetry request limit');
        const seq = ++broker.seq, controller = new AbortController(); broker.requests.add(controller);
        const timer = setTimeout(() => controller.abort(), 2000); timer.unref();
        // Explicit HTTP-only mode, never a fallback from a failed SHM channel.
        return (async () => {
          try {
            const response = await fetch(`${base}/api/agents/${id}/${kind}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runToken, ...data, seq }), signal: controller.signal,
            });
            if (!response.ok) throw telemetryError('TELEMETRY_HTTP', 'HTTP report rejected');
            return { seq, status: 'applied' };
          } catch (error) { warnTelemetry(broker, error.code ?? 'TELEMETRY_HTTP'); return { seq, status: 'unknown' }; }
          finally { clearTimeout(timer); broker.requests.delete(controller); }
        })();
      },
    };
    if (mode === 'shm') broker.client = createCanvasTelemetryClient({ config, name, epoch,
      onError: error => warnTelemetry(broker, error.code ?? 'TELEMETRY_ERROR'),
      onReceipt: receipt => { if (receipt.status !== 'applied') warnTelemetry(broker, receipt.code ?? 'TELEMETRY_REJECTED'); },
    });
    process[KEY] = broker; process.once('exit', broker.close);
  }
  broker.binding = { ctx, owner };
  broker.warned = null;
  if (broker.error) warnTelemetry(broker, broker.error);
  return broker;
}
export function detachTelemetryProcess(broker, owner, reason) {
  if (!broker || broker.binding?.owner !== owner) return;
  broker.binding = null;
  if (reason === 'quit') broker.close();
}
