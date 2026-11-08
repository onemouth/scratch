import { validMessageId } from '../shared/canvas-messages.js';

import { INBOX_VERSION, INBOX_PER_AGENT, INBOX_TOTAL, INBOX_BATCH } from '../shared/canvas-inbox.js';

// Ephemeral UI projection, not a mailbox, receipt history, persistence or replay.
// Only the process that owns a channel can report context inclusion for its IDs.
export function createAgentInbox({ getAgent, onChange = () => {}, now = Date.now }) {
  const records = new Map();
  let revision = 0;
  const touch = record => { record.revision = ++revision; onChange(); };
  const prune = () => { for (const id of records.keys()) if (!getAgent(id)) records.delete(id); };
  const recordFor = (id, generation) => {
    const record = records.get(id);
    return record?.generation === generation ? record : null;
  };
  const summary = id => {
    const record = records.get(id);
    if (!record) return { state: 'unavailable', count: null, revision: 0, generation: null,
      reason: getAgent(id)?.status === 'running' ? 'Waiting for Pi inbox tracking.' : 'Process ended; pending state cannot be confirmed.' };
    const active = record.ready && !record.closed && !record.failed;
    return { state: active ? 'active' : 'unavailable', count: active ? record.items.size : null,
      revision: record.revision, generation: record.generation,
      ...(!active ? { reason: record.reason || 'Waiting for Pi inbox tracking.' } : {}),
      ...(record.previousUnconfirmed ? { previousUnconfirmed: true } : {}) };
  };
  return {
    open(id, generation) {
      prune();
      const previous = records.get(id);
      const record = { generation, ready: false, closed: false, failed: false, seq: 0, items: new Map(),
        previousUnconfirmed: Boolean(previous?.items.size || previous?.previousUnconfirmed) };
      records.set(id, record); touch(record);
    },
    capacity(id, generation) {
      prune();
      const record = recordFor(id, generation);
      return Boolean(record && !record.closed && record.items.size < INBOX_PER_AGENT &&
        [...records.values()].reduce((total, value) => total + value.items.size, 0) < INBOX_TOTAL);
    },
    add(id, generation, frame) {
      const record = recordFor(id, generation);
      if (!record || record.closed) return;
      record.items.set(frame.messageId, { messageId: frame.messageId, sourceId: frame.sourceId,
        sourceName: getAgent(frame.sourceId)?.name || frame.sourceId, sourceGeneration: frame.sourceGeneration, text: frame.text, receivedAt: now(), state: 'pending' });
      touch(record);
    },
    handoff(id, generation, messageId, status, sourceId, sourceGeneration) {
      const record = recordFor(id, generation), item = record?.items.get(messageId);
      if (!item || (sourceId !== undefined && (item.sourceId !== sourceId || item.sourceGeneration !== sourceGeneration))) return;
      if (status === 'expired') { record.items.delete(messageId); touch(record); }
      else if (status === 'unknown' && item.state !== 'uncertain') { item.state = 'uncertain'; touch(record); }
      // delivered only means Pi accepted the API handoff. Keep the item for B.
    },
    observe(id, generation, report) {
      const record = recordFor(id, generation);
      if (!record || record.closed || record.failed) return;
      const allowed = new Set(['kind', 'version', 'seq', 'ready', 'ids', 'uncertainIds']);
      if (!report || Object.keys(report).some(key => !allowed.has(key)) || report.kind !== 'inbox' ||
        report.version !== INBOX_VERSION || report.ready !== true || !Number.isSafeInteger(report.seq) ||
        report.seq !== record.seq + 1 || !Array.isArray(report.ids) || report.ids.length > INBOX_BATCH ||
        report.ids.some(id => !validMessageId(id)) || new Set(report.ids).size !== report.ids.length ||
        (report.uncertainIds !== undefined && (!Array.isArray(report.uncertainIds) || report.uncertainIds.length > INBOX_BATCH ||
          report.uncertainIds.some(id => !validMessageId(id) || report.ids.includes(id)) ||
          new Set(report.uncertainIds).size !== report.uncertainIds.length))) {
        record.failed = true; record.reason = 'Pi inbox observation gap; pending state cannot be confirmed.'; touch(record); return;
      }
      record.seq = report.seq;
      let changed = !record.ready;
      record.ready = true;
      for (const messageId of report.ids) changed = record.items.delete(messageId) || changed;
      for (const messageId of report.uncertainIds ?? []) {
        const item = record.items.get(messageId);
        if (item && item.state !== 'uncertain') { item.state = 'uncertain'; changed = true; }
      }
      if (changed) touch(record);
    },
    close(id, generation) {
      const record = recordFor(id, generation);
      if (!record || record.closed) return;
      record.closed = true; record.reason = 'Process ended; pending state cannot be confirmed.'; touch(record);
      // No payload history is needed for a process with no unresolved messages.
      if (!record.items.size && !record.previousUnconfirmed) records.delete(id);
    },
    prune,
    summary,
    read(id) {
      prune();
      return { ...summary(id), messages: [...(records.get(id)?.items.values() ?? [])].map(({ sourceGeneration: _private, ...item }) => item) };
    },
  };
}
