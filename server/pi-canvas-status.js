import { transientMemoryError } from '../shared/canvas-memory.js';

const KEY = Symbol.for('agent-canvas.transport-status.v1');
const STATUS_KEY = 'canvas-transport';
// One process-owned footer entry, shared even across replacement module instances.
// This registry owns UI state only, never transport resources or model messages.
const registry = () => process[KEY] ??= new Map();
const text = entries => {
  const problems = entries.filter(entry => entry.problem);
  if (!problems.length) return undefined;
  const failed = problems.some(entry => !entry.problem.paused);
  return `Canvas ${failed ? 'error' : 'paused'}: ${problems.map(entry =>
    `${entry.channel}${entry.problem.paused ? (failed ? ' paused' : '') : ` ${entry.problem.code}`}`).join(', ')}`;
};
const render = ctx => {
  if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== 'function') return;
  const value = text([...registry().values()]);
  try { ctx.ui.setStatus(STATUS_KEY, value); } catch { /* UI cannot own transport lifetime. */ }
};
export function bindCanvasStatus(channel, owner, ctx) {
  const entries = registry(), previous = entries.get(channel);
  entries.set(channel, { channel, owner, ctx, problem: previous?.problem });
  render(ctx);
}
export function setCanvasStatus(channel, owner, error) {
  const entry = process[KEY]?.get(channel);
  if (!entry || entry.owner !== owner) return;
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TRANSPORT_ERROR';
  entry.problem = error ? { code, paused: !error.fatal && transientMemoryError(error) } : undefined;
  // Detached callbacks retain transport evidence in their broker, not old UI contexts.
  render(entry.ctx);
}
export function detachCanvasStatus(channel, owner) {
  const entries = process[KEY], entry = entries?.get(channel);
  if (!entry || entry.owner !== owner) return;
  entries.delete(channel);
  render(entry.ctx);
  if (!entries.size) delete process[KEY];
}
