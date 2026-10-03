import React, { useEffect, useRef, useState } from 'react';
import { createCardAutosaver } from './card-autosave.js';
import Markdown from 'react-markdown';
import { NodeResizer, useViewport } from '@xyflow/react';
import { CARD_LIMIT, inspectCardContent } from '../shared/card-content.js';

async function request(path, method, body) {
  const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
function CardIcon({ type }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {type === 'flip' ? <><rect x="7" y="7" width="13" height="13" rx="2" /><path d="M16 4H4v12M4 4l4 4" /></> : type === 'edit' ? <><path d="m4 16 12-12 4 4-12 12-5 1zM14 6l4 4" /></> : type === 'done' ? <path d="m5 12 4 4L19 6" /> : type === 'add' ? <path d="M12 5v14M5 12h14" /> : <path d="m5 5 14 14M19 5 5 19" />}
  </svg>;
}
export function CardFace({ card, readOnly = false, onRemove, onAdd, adding = false, onDelete, fontSize, draggable = false }) {
  const [back, setBack] = useState(false);
  const [editing, setEditing] = useState(!readOnly && !card.content);
  const [content, setContent] = useState(card.content);
  const [tags, setTags] = useState(card.tags.join(', '));
  const [links, setLinks] = useState((card.links || []).join(', '));
  const [status, setStatus] = useState({ state: 'saved', error: '' });
  const autosaver = useRef(null);
  useEffect(() => {
    if (readOnly) return;
    const saver = createCardAutosaver({
      initial: { content: card.content, tags: card.tags, links: card.links || [] },
      save: draft => request('/cards/' + card.id, 'PATCH', draft),
      onStatus: setStatus,
    });
    autosaver.current = saver;
    return () => { saver.dispose(); autosaver.current = null; };
  }, [card.id, readOnly]);
  useEffect(() => {
    if (!autosaver.current?.isDirty()) {
      autosaver.current?.adopt({ content: card.content, tags: card.tags, links: card.links || [] });
      setContent(card.content); setTags(card.tags.join(', ')); setLinks((card.links || []).join(', '));
    }
  }, [card.content, card.tags.join(', '), (card.links || []).join(', ')]);
  useEffect(() => { autosaver.current?.update(content, tags, links); }, [content, tags, links]);
  let units = 0, invalid = '';
  try { units = inspectCardContent(content); } catch (e) { invalid = e.message; }
  return <div className="card-face nowheel nopan">
    <header className={onRemove || draggable ? 'card-toolbar card-drag-handle' : 'card-toolbar'} aria-label={onRemove || draggable ? 'Drag to move card' : 'Card controls'}>
      <button type="button" className="card-icon nodrag" title={back ? 'View content' : 'View metadata'} aria-label={back ? 'View card content' : 'View card metadata'} aria-pressed={back} onClick={() => setBack(value => !value)}><CardIcon type="flip" /></button>
      {!readOnly && <button type="button" className="card-icon nodrag" title={editing ? 'Done editing' : 'Edit card'} aria-label={editing ? 'Done editing card' : 'Edit card'} aria-pressed={editing} onClick={() => setEditing(value => !value)}><CardIcon type={editing ? 'done' : 'edit'} /></button>}
      {onAdd && <button type="button" className="card-icon nodrag" title="Add to Agent Canvas" aria-label="Add card to Agent Canvas" disabled={adding} onClick={onAdd}><CardIcon type="add" /></button>}
      {onRemove && <button type="button" className="card-icon nodrag" title="Remove from Canvas (keeps card)" aria-label="Remove card from Canvas" onClick={onRemove}><CardIcon type="remove" /></button>}
    </header>
    <div className="card-body nodrag" style={fontSize === undefined ? undefined : { fontSize }}>
      {back ? <div className="card-meta"><dl><dt>ID</dt><dd>{card.id}</dd><dt>Tags</dt><dd>{editing ? <input aria-label="Card tags" placeholder="tag, tag" value={tags} onChange={e => setTags(e.target.value)} /> : tags.trim() ? [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))].map(tag => <span className="card-tag" key={tag}>{tag}</span>) : '—'}</dd><dt title="Links are bidirectional: adding or removing one updates both cards.">Links ↔</dt><dd>{editing ? <input aria-label="Card links" placeholder="2026-10-03-0001, 2026-10-03-0002" value={links} onChange={e => setLinks(e.target.value)} /> : links.trim() ? [...new Set(links.split(/[,\s]+/).filter(Boolean))].map(id => <span className="card-tag" key={id}>{id}</span>) : '—'}</dd></dl></div>
        : editing ? <textarea aria-label="Card Markdown" maxLength={20000} value={content} onChange={e => setContent(e.target.value)} placeholder="One idea, in Markdown…" />
          : <div className="card-markdown"><Markdown skipHtml disallowedElements={['img']}>{content || '*Empty card*'}</Markdown></div>}
    </div>
    <div className={units > CARD_LIMIT || invalid ? 'card-count invalid nodrag' : 'card-count nodrag'} title="CJK characters + English words. Markdown syntax, whitespace and punctuation do not count.">{invalid || `Text units: ${units} / ${CARD_LIMIT}`}</div>
    {!readOnly && <div className="card-footer nodrag"><div className={status.state === 'error' ? 'node-error' : 'card-count'} role="status">{status.state === 'error' ? `Not saved: ${status.error}` : status.state === 'saving' ? 'Saving…' : 'Saved'}{status.state === 'error' && !invalid && units <= CARD_LIMIT && <button type="button" onClick={() => autosaver.current?.update(content, tags, links)}>Retry</button>}</div>{onDelete && <button type="button" className="card-delete" onClick={onDelete}>Delete permanently…</button>}</div>}
  </div>;
}
export function CardNode({ id, data, selected }) {
  const { zoom } = useViewport();
  // Scale with the paper, never below 11 screen px.
  const fontSize = Math.max(13, 11 / zoom);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true); setError('');
    try { await request('/cards/' + data.card.id + '/placement', 'POST', {}); }
    catch (e) { setError(e.message); }
    finally { setAdding(false); }
  };
  const placementPath = data.cardBox ? '/card-box/placements/' + data.card.id : '/card-placements/' + data.card.id;
  const remove = async () => {
    try { await request(placementPath, 'DELETE', {}); }
    catch (e) { setError(e.message); }
  };
  const destroy = async () => {
    if (!confirm('Permanently delete this card from the card box and Canvas?')) return;
    try { await request('/cards/' + data.card.id, 'DELETE', { confirm: true }); }
    catch (e) { setError(e.message); }
  };
  return <>
    <NodeResizer isVisible={selected} minWidth={240} minHeight={240} onResizeEnd={(_, p) => request(placementPath, 'PATCH', { x: p.x, y: p.y, width: p.width, height: p.height }).catch(e => setError(e.message))} />
    <section className="zettel-card">
      <CardFace card={data.card} onRemove={data.cardBox ? undefined : remove} onAdd={data.cardBox && !data.inAgentCanvas ? add : undefined} adding={adding} onDelete={destroy} fontSize={fontSize} draggable />
      {error && <div className="node-error" role="alert">{error}</div>}
    </section>
  </>;
}
