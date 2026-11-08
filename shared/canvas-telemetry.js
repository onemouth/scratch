import { isAbsolute } from 'node:path';
import { validId, messageError } from './canvas-messages.js';

export const TELEMETRY_VERSION = 1;
export const TELEMETRY_SLOTS = 16;
export const TELEMETRY_TTL = 10000;
export const telemetryError = messageError;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
export function validateTelemetryData(kind, data) {
  const valid = kind === 'activity'
    ? exact(data, ['state', 'summary']) && ['working', 'idle'].includes(data.state) && (data.summary === undefined || (data.state === 'idle' && text(data.summary, 240)))
    : kind === 'session'
      ? exact(data, ['sessionFile', 'sessionId']) && text(data.sessionId, 100) && (data.sessionFile === null || (text(data.sessionFile, 4096) && isAbsolute(data.sessionFile)))
      : kind === 'progress' && exact(data, ['text']) && text(data.text, 500, true);
  if (!valid) throw telemetryError('TELEMETRY_ARGUMENT', 'Invalid telemetry kind or fields');
}
export function validateTelemetry(frame, now = Date.now()) {
  if (!exact(frame, ['version', 'seq', 'kind', 'data', 'expiresAt']) || frame.version !== TELEMETRY_VERSION ||
      !Number.isSafeInteger(frame.seq) || frame.seq < 1 || !Number.isSafeInteger(frame.expiresAt) || frame.expiresAt > now + TELEMETRY_TTL) {
    throw telemetryError('TELEMETRY_ARGUMENT', 'Invalid telemetry frame');
  }
  validateTelemetryData(frame.kind, frame.data);
  if (frame.expiresAt <= now) throw telemetryError('TELEMETRY_EXPIRED', 'Telemetry deadline passed');
}
export function validateTelemetryConfig(config, epoch) {
  if (config?.version !== TELEMETRY_VERSION || config.epoch !== epoch || !validId(config.id) || !validId(config.generation) ||
      !['reports', 'receipts', 'tx', 'rx'].every(key => typeof config[key] === 'string' && /^\/scsh-[a-f0-9]{20}$/.test(config[key]))) {
    throw telemetryError('SHM_VERSION', 'Incompatible telemetry process channel');
  }
}
