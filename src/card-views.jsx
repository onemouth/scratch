import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CardFace } from './cards.jsx';
import { CardMarkdown } from './card-markdown.js';

async function request(path, method = 'GET', body) {
  const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await res.json();
  if (!res.ok) throw Error(result.error || `HTTP ${res.status}`);
  return result;
}
function Dialog({ title, children, onClose }) {
  const root = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    (root.current?.querySelector('input') ?? root.current?.querySelector('button'))?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={root} className="modal view-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const items = [...root.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')];
        const index = items.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0) { e.preventDefault(); items.at(-1)?.focus(); }
        else if (!e.shiftKey && index === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
      }
    }}><div className="modal-head"><h2>{title}</h2><button type="button" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</section>
  </div>, document.body);
}
export function ViewControls({ box, libraryOpen, onLibrary, onChange, onError, beforeSwitch, exploreRequest, onExploreCreated }) {
  const active = box?.views?.find(v => v.id === box.activeViewId);
  const handledExplore = useRef(null);
  const [dialog, setDialog] = useState(null), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const open = (type, target) => { setError(''); setName(active?.name || ''); setDialog({ type, target, source: box.activeViewId }); };
  const run = async operation => {
    setBusy(true); setError('');
    try { onChange(await operation()); setDialog(null); }
    catch (e) { setError(e.message); if (!dialog) onError(e.message); }
    finally { setBusy(false); }
  };
  const transition = (target, action, saveName, source = box.activeViewId) => run(async () => {
    await beforeSwitch(source);
    const selection = typeof target === 'object' ? { name: target.name, cardIds: target.cardIds } : {};
    const body = { ...selection, fromViewId: source, ...(action ? { temporaryAction: action, saveName } : {}) };
    const result = target === 'new' || typeof target === 'object' ? await request('/card-box/views', 'POST', body) : await request(`/card-box/views/${target}/activate`, 'POST', body);
    if (typeof target === 'object') onExploreCreated(result.activeViewId);
    return result;
  });
  const leave = target => { if (active && !active.saved) open('leave', target); else transition(target); };
  useEffect(() => {
    if (!active || !exploreRequest || handledExplore.current === exploreRequest.id) return;
    handledExplore.current = exploreRequest.id;
    leave(exploreRequest);
  }, [exploreRequest?.id, active?.id]);
  if (!active) return null;
  return <>
    <nav className="viewbar" aria-label="Card box views">
      <button type="button" aria-pressed={libraryOpen} onClick={onLibrary}>Library</button>
      <label>View <select aria-label="Current view" value={active.id} disabled={busy} onChange={e => leave(e.target.value)}>
        {!active.saved && <option value={active.id}>{active.name || 'Untitled'} · Temporary</option>}
        {box.views.filter(v => v.saved).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => leave('new')}>＋ New view</button>
      {!active.saved && <button type="button" disabled={busy} onClick={() => open('save')}>Save view</button>}
      <span className="view-state">{active.placements.length} cards · {active.system === 'unfiled' ? 'Dynamic' : active.saved ? 'Autosave' : 'Temporary · recoverable'}</span>
      {!active.system && <button type="button" disabled={busy} onClick={() => open('rename')}>Rename</button>}
      {!active.system && <button type="button" className="view-danger" disabled={busy} onClick={() => open('delete')}>Delete view…</button>}
    </nav>
    {dialog && <Dialog title={dialog.type === 'leave' ? 'Leave temporary view?' : dialog.type === 'delete' ? 'Delete view?' : dialog.type === 'save' ? 'Save view' : 'Rename view'} onClose={() => { if (!busy) setDialog(null); }}>
      <form onSubmit={e => {
        e.preventDefault();
        if (dialog.type === 'leave') transition(dialog.target, 'save', name, dialog.source);
        else if (dialog.type === 'delete') run(() => request(`/card-box/views/${dialog.source}`, 'DELETE', { confirm: true, fromViewId: dialog.source }));
        else run(() => request(`/card-box/views/${dialog.source}${dialog.type === 'save' ? '/save' : ''}`, dialog.type === 'save' ? 'POST' : 'PATCH', { name }));
      }}>
        {dialog.type === 'delete' ? <p>Only this view and its layout will be deleted. Library cards and the shared agent are kept.</p> : <><p>{dialog.type === 'leave' ? 'Save this view or discard it before switching. Cancel keeps the current view.' : 'View names must be unique.'}</p><label>View name<input aria-label="View name" value={name} maxLength={120} disabled={busy} onChange={e => setName(e.target.value)} /></label></>}
        {error && <p role="alert" className="node-error">{error}</p>}
        <div className="view-dialog-actions"><button type="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
          {dialog.type === 'leave' && <button type="button" disabled={busy} onClick={() => transition(dialog.target, 'discard', undefined, dialog.source)}>Discard and switch</button>}
          <button type="submit" className="primary" disabled={busy || (dialog.type !== 'delete' && !name.trim())}>{busy ? 'Saving…' : dialog.type === 'leave' ? 'Save and switch' : dialog.type === 'delete' ? 'Delete view' : dialog.type === 'save' ? 'Save view' : 'Rename'}</button>
        </div>
      </form>
    </Dialog>}
  </>;
}

export function CardLibrary({ cards, box, onChange, onClose }) {
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [result, setResult] = useState({ cards: [], total: 0 });
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(null), [preview, setPreview] = useState(null);
  const revision = cards.map(c => c.id + ':' + c.updatedAt).join('|');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cards?q=${encodeURIComponent(query)}&limit=24&offset=${offset}`, { signal: controller.signal });
        const value = await res.json(); if (!res.ok) throw Error(value.error);
        setResult(value); setError('');
        if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / 24) * 24));
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, offset, revision]);
  const members = new Set((box?.placements || []).map(p => p.cardId));
  const systemView = box?.views?.find(view => view.id === box.activeViewId)?.system;
  const toggle = async card => {
    setBusy(card.id); setError('');
    try { onChange(await request(`/card-box/views/${box.activeViewId}/cards/${card.id}`, members.has(card.id) ? 'DELETE' : 'POST', {})); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };
  const shown = result.cards.flatMap(c => { const current = cards.find(card => card.id === c.id); return current ? [current] : []; });
  const previewCard = cards.find(c => c.id === preview);
  return <>
    <aside className="card-library" aria-label="Card library">
      <header><h2>Card library</h2><button type="button" aria-label="Close library" onClick={onClose}>×</button></header>
      <input type="search" aria-label="Search cards" placeholder="Search title, content, tags or ID…" value={query} maxLength={1000} onChange={e => { setQuery(e.target.value); setOffset(0); }} />
      <p role="status">{loading ? 'Searching…' : `${result.total} cards`} · matches any search word</p>
      {error && <p className="node-error" role="alert">{error}</p>}
      <div className="library-grid">{shown.map(card => <article className="library-card" key={card.id}>
        <button type="button" className="library-preview" aria-label={`Preview card ${card.id}`} onClick={() => setPreview(card.id)}>{card.type === 'interactive' ? <div className="library-interactive"><span aria-hidden="true">◇</span><strong>{card.title}</strong><small>Interactive card</small></div> : <>{card.image && <img className="library-thumbnail" src={card.image.url} alt={card.image.name} loading="lazy" />}{card.audio && <span className="library-audio">♫ {card.audio.name}</span>}<div className="card-markdown"><CardMarkdown content={card.content} preview /></div></>}</button>
        <footer><span>{card.id}</span>{systemView === 'unfiled' ? <span className="library-membership">Unfiled</span> : <button type="button" disabled={!!busy || !box?.activeViewId} aria-label={`${members.has(card.id) ? 'Remove' : 'Add'} card ${card.id} ${members.has(card.id) ? 'from' : 'to'} current view`} onClick={() => toggle(card)}>{busy === card.id ? '…' : members.has(card.id) ? '✓ Remove' : '＋ Add'}</button>}</footer>
        {card.tags.length > 0 && <div className="library-tags">{card.tags.join(' · ')}</div>}
      </article>)}</div>
      {!loading && !shown.length && <p>No matching cards.</p>}
      <div className="library-pagination"><button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(n => Math.max(0, n - 24))}>Previous</button><span>{Math.floor(offset / 24) + 1}</span><button type="button" disabled={offset + 24 >= result.total || loading} onClick={() => setOffset(n => n + 24)}>Next</button></div>
    </aside>
    {previewCard && <Dialog title={`Card ${previewCard.id}`} onClose={() => setPreview(null)}><div className="library-full-preview"><CardFace card={previewCard} readOnly /></div></Dialog>}
  </>;
}
