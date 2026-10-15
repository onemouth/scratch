import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cardTypography, viewportWidth, subscribeViewportWidth } from './card-typography.js';
import { CardAudio, CardImage, CardAttachmentInfo, useCardUpload } from './card-media.jsx';
import { createAutosaver, createCardAutosaver } from './card-autosave.js';
import { InteractiveContent } from './interactive-card.jsx';
import { validateCardLinks } from '../shared/card-links.js';
import { CardMarkdown } from './card-markdown.js';
import 'katex/dist/katex.min.css';
import { NodeResizer, useViewport } from '@xyflow/react';
import { CARD_LIMIT, inspectCardContent } from '../shared/card-content.js';

async function request(path, method, body) {
  const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
// Unmounted view cards retain drafts in this page, not in persistent storage.
const cardDrafts = new Map();
export function reconcileCardDrafts(cards) {
  const ids = new Set(cards.map(c => c.id));
  for (const [key, draft] of cardDrafts) if (!ids.has(draft.cardId)) cardDrafts.delete(key);
}
function CardIcon({ type }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {type === 'flip' ? <><rect x="7" y="7" width="13" height="13" rx="2" /><path d="M16 4H4v12M4 4l4 4" /></> : type === 'edit' ? <><path d="m4 16 12-12 4 4-12 12-5 1zM14 6l4 4" /></> : type === 'done' ? <path d="m5 12 4 4L19 6" /> : type === 'add' ? <path d="M12 5v14M5 12h14" /> : <path d="m5 5 14 14M19 5 5 19" />}
  </svg>;
}
function interactiveDraft(title, tags, links) {
  title = title.trim();
  if (!title || [...title].length > 120) throw new Error('Title must contain 1–120 characters');
  const tagValues = [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))];
  if (tagValues.length > 30 || tagValues.some(tag => [...tag].length > 60 || /[\n\r]/.test(tag))) throw new Error('Tags: up to 30, at most 60 characters each, no newlines');
  return { title, tags: tagValues, links: validateCardLinks(links.split(/[,\s]+/).filter(Boolean)) };
}

function InteractiveCardFace({ card, readOnly, onRemove, onAdd, adding, onDelete, onTagClick, onLinkClick, draggable, draftScope, removeFromView }) {
  const draftKey = draftScope + ':' + card.id;
  const restored = useRef(readOnly ? null : cardDrafts.get(draftKey));
  const [back, setBack] = useState(restored.current?.back ?? false);
  const [editing, setEditing] = useState(restored.current?.editing ?? false);
  const [title, setTitle] = useState(restored.current?.title ?? card.title);
  const [tags, setTags] = useState(restored.current?.tags ?? card.tags.join(', '));
  const [links, setLinks] = useState(restored.current?.links ?? (card.links || []).join(', '));
  const [status, setStatus] = useState({ state: 'saved', error: '' });
  const autosaver = useRef(null);
  const latest = useRef(null);
  latest.current = { cardId: card.id, title, tags, links, back, editing, interactiveMetadata: true };
  useEffect(() => {
    if (readOnly) return;
    const saver = createAutosaver({ initial: { title: card.title, tags: card.tags, links: card.links || [] }, validate: interactiveDraft,
      save: draft => request('/cards/' + card.id, 'PATCH', draft), onStatus: value => { setStatus(value); if (value.state === 'saved') cardDrafts.delete(draftKey); } });
    autosaver.current = saver;
    if (restored.current) saver.update(title, tags, links);
    return () => {
      if (saver.isDirty()) cardDrafts.set(draftKey, latest.current); else cardDrafts.delete(draftKey);
      saver.dispose({ flush: true }); autosaver.current = null;
    };
  }, [card.id, readOnly]);
  useEffect(() => {
    if (!autosaver.current?.isDirty()) {
      autosaver.current?.adopt({ title: card.title, tags: card.tags, links: card.links || [] });
      setTitle(card.title); setTags(card.tags.join(', ')); setLinks((card.links || []).join(', '));
    }
  }, [card.title, card.tags.join(', '), (card.links || []).join(', ')]);
  useEffect(() => { autosaver.current?.update(title, tags, links); }, [title, tags, links]);
  const tagDisplay = [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))];
  const linkDisplay = [...new Set(links.split(/[,\s]+/).filter(Boolean))];
  return <div className="card-face interactive-card-face nowheel nopan">
    <header className={onRemove || draggable ? 'card-toolbar card-drag-handle' : 'card-toolbar'} aria-label={onRemove || draggable ? 'Drag to move card' : 'Card controls'}>
      <h3 className="interactive-toolbar-title" title={title}>{title}</h3>
      <button type="button" className="card-icon nodrag" title={back ? 'View content' : 'View metadata'} aria-label={back ? 'View card content' : 'View card metadata'} aria-pressed={back} onClick={() => setBack(value => !value)}><CardIcon type="flip" /></button>
      {!readOnly && back && <button type="button" className="card-icon nodrag" title={editing ? 'Done editing' : 'Edit card'} aria-label={editing ? 'Done editing card' : 'Edit card'} aria-pressed={editing} onClick={() => setEditing(value => !value)}><CardIcon type={editing ? 'done' : 'edit'} /></button>}
      {onAdd && <button type="button" className="card-icon nodrag" title="Add to Agent Canvas" aria-label="Add card to Agent Canvas" disabled={adding} onClick={onAdd}><CardIcon type="add" /></button>}
      {onRemove && <button type="button" className="card-icon nodrag" title={removeFromView ? 'Remove from current view (keeps library card)' : 'Remove from Canvas (keeps card)'} aria-label={removeFromView ? 'Remove card from current view' : 'Remove card from Canvas'} onClick={onRemove}><CardIcon type="remove" /></button>}
    </header>
    <div className="card-body nodrag">{back ? <div className="card-meta"><dl>
      <dt>ID</dt><dd>{card.id}</dd><dt>Type</dt><dd>Interactive</dd>
      <dt>Title</dt><dd>{editing ? <input aria-label="Interactive card title" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /> : title || '—'}</dd>
      <dt>Tags</dt><dd>{editing ? <input aria-label="Card tags" placeholder="tag, tag" value={tags} onChange={event => setTags(event.target.value)} /> : tagDisplay.length ? tagDisplay.map(tag => onTagClick ? <button type="button" className="card-tag card-meta-link" key={tag} onClick={() => onTagClick(tag)}>{tag}</button> : <span className="card-tag" key={tag}>{tag}</span>) : '—'}</dd>
      <dt title="Links are bidirectional: adding or removing one updates both cards.">Links ↔</dt><dd>{editing ? <input aria-label="Card links" placeholder="2026-10-03-0001, 2026-10-03-0002" value={links} onChange={event => setLinks(event.target.value)} /> : linkDisplay.length ? linkDisplay.map(linkedId => onLinkClick ? <button type="button" className="card-tag card-meta-link" key={linkedId} onClick={() => onLinkClick(linkedId)}>{linkedId}</button> : <span className="card-tag" key={linkedId}>{linkedId}</span>) : '—'}</dd>
    </dl></div>
      : readOnly ? <div className="interactive-library-message">Interactive content runs only when placed on a canvas.</div> : <InteractiveContent card={card} />}</div>
    {!readOnly && <div className="card-footer nodrag"><div className={status.state === 'error' ? 'node-error' : 'card-count'} role="status">{status.state === 'error' ? `Not saved: ${status.error}` : status.state === 'saving' ? 'Saving…' : 'Saved'}{status.state === 'error' && <button type="button" onClick={() => autosaver.current?.update(title, tags, links)}>Retry</button>}</div>{onDelete && <button type="button" className="card-delete" onClick={onDelete}>Delete permanently…</button>}</div>}
  </div>;
}

function MarkdownCardFace({ card, readOnly = false, onRemove, onAdd, adding = false, onDelete, onTagClick, onLinkClick, fontSize, draggable = false, draftScope = 'agents', removeFromView = false }) {
  const media = useCardUpload(card);
  const draftKey = draftScope + ':' + card.id;
  const restored = useRef(readOnly ? null : cardDrafts.get(draftKey));
  const [back, setBack] = useState(restored.current?.back ?? false);
  const [editing, setEditing] = useState(restored.current?.editing ?? (!readOnly && !card.content));
  const [content, setContent] = useState(restored.current?.content ?? card.content);
  const [tags, setTags] = useState(restored.current?.tags ?? card.tags.join(', '));
  const [links, setLinks] = useState(restored.current?.links ?? (card.links || []).join(', '));
  const latest = useRef(null);
  latest.current = { cardId: card.id, content, tags, links, back, editing };
  const [status, setStatus] = useState({ state: 'saved', error: '' });
  const autosaver = useRef(null);
  useEffect(() => {
    if (readOnly) return;
    const saver = createCardAutosaver({
      initial: { content: card.content, tags: card.tags, links: card.links || [] },
      save: draft => request('/cards/' + card.id, 'PATCH', draft),
      onStatus: value => { setStatus(value); if (value.state === 'saved') cardDrafts.delete(draftKey); },
    });
    autosaver.current = saver;
    if (restored.current) saver.update(content, tags, links);
    return () => {
      if (saver.isDirty()) cardDrafts.set(draftKey, latest.current);
      else cardDrafts.delete(draftKey);
      saver.dispose({ flush: true }); autosaver.current = null;
    };
  }, [card.id, readOnly]);
  useEffect(() => {
    if (!autosaver.current?.isDirty()) {
      autosaver.current?.adopt({ content: card.content, tags: card.tags, links: card.links || [] });
      setContent(card.content); setTags(card.tags.join(', ')); setLinks((card.links || []).join(', '));
    }
  }, [card.content, card.tags.join(', '), (card.links || []).join(', ')]);
  useEffect(() => { autosaver.current?.update(content, tags, links); }, [content, tags, links]);
  const { units, invalid } = useMemo(() => {
    try { return { units: inspectCardContent(content), invalid: '' }; }
    catch (e) { return { units: 0, invalid: e.message }; }
  }, [content]);
  return <div className={`card-face nowheel nopan${media.dropping ? ' media-drop-target' : ''}`} {...(readOnly ? {} : media.dropProps)}>
    <header className={onRemove || draggable ? 'card-toolbar card-drag-handle' : 'card-toolbar'} aria-label={onRemove || draggable ? 'Drag to move card' : 'Card controls'}>
      <button type="button" className="card-icon nodrag" title={back ? 'View content' : 'View metadata'} aria-label={back ? 'View card content' : 'View card metadata'} aria-pressed={back} onClick={() => setBack(value => !value)}><CardIcon type="flip" /></button>
      {!readOnly && <button type="button" className="card-icon nodrag" title={editing ? 'Done editing' : 'Edit card'} aria-label={editing ? 'Done editing card' : 'Edit card'} aria-pressed={editing} onClick={() => setEditing(value => !value)}><CardIcon type={editing ? 'done' : 'edit'} /></button>}
      {onAdd && <button type="button" className="card-icon nodrag" title="Add to Agent Canvas" aria-label="Add card to Agent Canvas" disabled={adding} onClick={onAdd}><CardIcon type="add" /></button>}
      {onRemove && <button type="button" className="card-icon nodrag" title={removeFromView ? "Remove from current view (keeps library card)" : "Remove from Canvas (keeps card)"} aria-label={removeFromView ? "Remove card from current view" : "Remove card from Canvas"} onClick={onRemove}><CardIcon type="remove" /></button>}
    </header>
    <div className="card-body nodrag" style={fontSize === undefined ? undefined : { fontSize }}>
      {back ? <div className="card-meta"><dl><dt>ID</dt><dd>{card.id}</dd><dt>Tags</dt><dd>{editing ? <input aria-label="Card tags" placeholder="tag, tag" value={tags} onChange={e => setTags(e.target.value)} /> : tags.trim() ? [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))].map(tag => onTagClick ? <button type="button" className="card-tag card-meta-link" title={`Open a temporary view for tag ${tag}`} key={tag} onClick={() => onTagClick(tag)}>{tag}</button> : <span className="card-tag" key={tag}>{tag}</span>) : '—'}</dd><dt title="Links are bidirectional: adding or removing one updates both cards.">Links ↔</dt><dd>{editing ? <input aria-label="Card links" placeholder="2026-10-03-0001, 2026-10-03-0002" value={links} onChange={e => setLinks(e.target.value)} /> : links.trim() ? [...new Set(links.split(/[,\s]+/).filter(Boolean))].map(linkedId => onLinkClick ? <button type="button" className="card-tag card-meta-link" title={`Open all cards recursively linked to ${linkedId}`} key={linkedId} onClick={() => onLinkClick(linkedId)}>{linkedId}</button> : <span className="card-tag" key={linkedId}>{linkedId}</span>) : '—'}</dd><CardAttachmentInfo card={card} onRemove={media.remove} busy={media.status.busy || readOnly} /></dl></div>
        : <><div className="card-attachments">{card.audio && <CardAudio file={card.audio} />}{card.image && <CardImage key={card.image.id} file={card.image} />}</div>{editing ? <textarea aria-label="Card Markdown" maxLength={20000} value={content} onChange={e => setContent(e.target.value)} placeholder="One idea, in Markdown…" />
          : <div className="card-markdown"><CardMarkdown content={content} /></div>}</>}
    </div>
    <div className={units > CARD_LIMIT || invalid ? 'card-count invalid nodrag' : 'card-count nodrag'} title="CJK characters + words. Math text, variables and numbers count; LaTeX command names, delimiters and punctuation do not.">{invalid || `Text units: ${units} / ${CARD_LIMIT}`}</div>
    {media.dropping && <div className="card-drop-hint">Drop image or audio here</div>}
    {media.status.busy && <div className="card-count" role="status">{media.status.message}</div>}
    {media.status.error && <div className="card-media-error" role="alert">{media.status.error}</div>}
    {!readOnly && <div className="card-footer nodrag"><div className={status.state === 'error' ? 'node-error' : 'card-count'} role="status">{status.state === 'error' ? `Not saved: ${status.error}` : status.state === 'saving' ? 'Saving…' : 'Saved'}{status.state === 'error' && !invalid && units <= CARD_LIMIT && <button type="button" onClick={() => autosaver.current?.update(content, tags, links)}>Retry</button>}</div>{onDelete && <button type="button" className="card-delete" onClick={onDelete}>Delete permanently…</button>}</div>}
  </div>;
}
export function CardFace(props) {
  return props.card.type === 'interactive' ? <InteractiveCardFace {...props} /> : <MarkdownCardFace {...props} />;
}

export function CardNode({ id, data, selected }) {
  const { zoom } = useViewport();
  const width = useSyncExternalStore(subscribeViewportWidth, viewportWidth, viewportWidth);
  const { fontSize } = cardTypography(width, zoom);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const resizeView = useRef(null);
  const add = async () => {
    setAdding(true); setError('');
    try { await request('/cards/' + data.card.id + '/placement', 'POST', {}); }
    catch (e) { setError(e.message); }
    finally { setAdding(false); }
  };
  const placementPath = data.cardBox ? (data.viewId ? '/card-box/views/' + data.viewId + '/cards/' + data.card.id : '/card-box/placements/' + data.card.id) : '/card-placements/' + data.card.id;
  const remove = async () => {
    try { await request(placementPath, 'DELETE', {}); }
    catch (e) { setError(e.message); }
  };
  const destroy = async () => {
    const message = data.card.type === 'interactive'
      ? 'Permanently delete this interactive card from the card box and Canvas? Its private interactive assets will also be deleted.'
      : 'Permanently delete this card from the card box and Canvas? Attachment files will be retained for a future audit.';
    if (!confirm(message)) return;
    try { await request('/cards/' + data.card.id, 'DELETE', { confirm: true }); }
    catch (e) { setError(e.message); }
  };
  return <>
    <NodeResizer isVisible={selected} minWidth={data.card.type === 'interactive' ? 320 : 240} minHeight={240} onResizeStart={() => { resizeView.current = data.viewId; }} onResizeEnd={(_, p) => {
      if (data.cardBox && resizeView.current !== data.viewId) { queueMicrotask(() => data.restorePlacement(id, data.placement)); return; }
      request(placementPath, 'PATCH', { x: p.x, y: p.y, width: p.width, height: p.height }).catch(e => setError(e.message));
    }} />
    <section className="zettel-card">
      <CardFace card={data.card} onRemove={data.cardBox && (!data.viewId || data.systemView) ? undefined : remove} onAdd={data.cardBox && !data.inAgentCanvas ? add : undefined} adding={adding} onDelete={destroy} onTagClick={data.cardBox && data.viewId ? tag => data.onExploreTag(tag) : undefined} onLinkClick={data.cardBox && data.viewId ? linkedId => data.onExploreLink(data.card.id, linkedId) : undefined} fontSize={fontSize} draftScope={data.cardBox ? 'card-box' : 'agents'} removeFromView={!!data.cardBox} draggable />
      {error && <div className="node-error" role="alert">{error}</div>}
    </section>
  </>;
}
