import { validateCardLinks } from '../shared/card-links.js';
import { validateCardContent } from '../shared/card-content.js';

export function cardDraft(content, tags, links = '') {
  validateCardContent(content);
  const values = [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))];
  if (values.length > 30 || values.some(tag => [...tag].length > 60 || /[\n\r]/.test(tag))) throw new Error('Tags: up to 30, at most 60 characters each, no newlines');
  return { content, tags: values, links: validateCardLinks(links.split(/[,\s]+/).filter(Boolean)) };
}

// Serialize writes so an older request cannot overwrite a newer draft.
export function createCardAutosaver({ initial, save, onStatus, delay = 500 }) {
  let draft = { ...initial, links: initial.links || [] };
  let acknowledged = JSON.stringify(draft);
  let revision = 0;
  let timer;
  let running = false;
  let disposed = false;
  let invalid = '';
  const dirty = () => !!invalid || JSON.stringify(draft) !== acknowledged;
  const report = (state, error = '') => { if (!disposed) onStatus({ state, error }); };
  const send = async () => {
    timer = undefined;
    if (disposed || running || invalid || !dirty()) return;
    running = true;
    const sent = JSON.stringify(draft), sentRevision = revision;
    report('saving');
    try {
      await save(JSON.parse(sent));
      acknowledged = sent;
      if (revision === sentRevision) report('saved');
    } catch (error) {
      if (revision === sentRevision) report('error', error.message);
    } finally {
      running = false;
      if (!disposed && revision !== sentRevision && !invalid && dirty() && !timer) timer = setTimeout(send, delay);
    }
  };
  return {
    isDirty: () => running || dirty(),
    adopt(value) { if (!running && !dirty()) { value = { ...value, links: value.links || [] }; draft = value; acknowledged = JSON.stringify(value); } },
    update(content, tags, links = '') {
      clearTimeout(timer); timer = undefined; revision++;
      try { draft = cardDraft(content, tags, links); invalid = ''; }
      catch (error) { invalid = error.message; report('error', invalid); return; }
      if (!dirty()) { report(running ? 'saving' : 'saved'); return; }
      report('saving');
      timer = setTimeout(send, delay);
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
