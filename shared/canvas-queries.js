import { validId, messageError } from './canvas-messages.js';

export const QUERY_VERSION = 1;
export const QUERY_SLOTS = 16;
export const QUERY_TTL = 10000;
export const QUERY_BYTES = 60000;
export const queryError = messageError;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function validateQuery(kind, params) {
  const page = exact(params, ['offset', 'limit']) &&
    (params.offset === undefined || (Number.isSafeInteger(params.offset) && params.offset >= 0)) &&
    (params.limit === undefined || (Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100));
  if (!(kind === 'agent' ? exact(params, ['agentId']) && validId(params.agentId) : ['agents', 'layout'].includes(kind) && page)) {
    throw queryError('QUERY_ARGUMENT', 'Invalid query kind or fields');
  }
}
export function validateQueryFrame(frame, now = Date.now()) {
  if (!exact(frame, ['version', 'seq', 'kind', 'params', 'expiresAt']) || frame.version !== QUERY_VERSION ||
    !Number.isSafeInteger(frame.seq) || frame.seq < 1 || !Number.isSafeInteger(frame.expiresAt) || frame.expiresAt > now + QUERY_TTL) {
    throw queryError('QUERY_ARGUMENT', 'Invalid query frame');
  }
  validateQuery(frame.kind, frame.params);
  if (frame.expiresAt <= now) throw queryError('QUERY_EXPIRED', 'Query deadline passed');
}
export function validateQueryConfig(config, epoch) {
  if (config?.version !== QUERY_VERSION || config.epoch !== epoch || !validId(config.id) || !validId(config.generation) ||
    !['requests', 'responses', 'tx', 'rx'].every(key => typeof config[key] === 'string' && /^\/scsh-[a-f0-9]{20}$/.test(config[key]))) {
    throw queryError('SHM_VERSION', 'Incompatible query process channel');
  }
}
export const queryFits = value => Buffer.byteLength(JSON.stringify(value)) <= QUERY_BYTES;
// Each page is a fresh sample, NOT a transaction spanning subsequent pages.
// Never truncate individual metadata records: oversized records fail explicitly.
export function queryPage(key, values, { offset = 0, limit = 20 } = {}) {
  const items = [];
  for (const item of values.slice(offset, offset + limit)) {
    if (Buffer.byteLength(JSON.stringify({ [key]: [...items, item] })) > QUERY_BYTES - 1024) {
      if (!items.length) throw queryError('QUERY_CAPACITY', 'One query record exceeds the response byte limit');
      break;
    }
    items.push(item);
  }
  return { [key]: items, total: values.length, offset, nextOffset: offset + items.length < values.length ? offset + items.length : null };
}
