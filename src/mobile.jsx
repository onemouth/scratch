import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CardMarkdown } from './card-markdown.js';
import { CardAudio, CardImage } from './card-media.jsx';
import { InteractiveContent } from './interactive-card.jsx';
import { MobileTerminal } from './mobile-terminal.jsx';
import { mobileAgent, mobileCards, normalizeTag } from './mobile-state.js';
import './mobile.css';

// Read-only by construction: no autosavers, editable drafts, upload hooks,
// shared view activation, membership operations or geometry writers are mounted.
function CardReader({ card, onCard, onTag }) {
  return <article className="mobile-card-reader">
    <h2>{card.type === 'interactive' ? card.title : card.id}</h2>
    {card.type === 'interactive' ? <div className="mobile-interactive"><InteractiveContent card={card} /></div> : <>
      {card.image && <CardImage file={card.image} />}
      {card.audio && <CardAudio file={card.audio} />}
      <div className="card-markdown"><CardMarkdown content={card.content} /></div>
    </>}
    <footer><small>{card.id} · Read only</small>
      <div className="mobile-tags">{card.tags.map(tag => <button type="button" key={tag} onClick={() => onTag(tag)}>{tag}</button>)}</div>
      {!!card.links?.length && <nav aria-label="Linked cards">{card.links.map(id => <button type="button" key={id} onClick={() => onCard(id)}>{id}</button>)}</nav>}
    </footer>
  </article>;
}

export function MobileApp() {
  const [state, setState] = useState({ agents: [], cards: [], scoreboard: [] });
  const [connected, setConnected] = useState(false), [tab, setTab] = useState('board');
  const [agentId, setAgentId] = useState(null), [cardId, setCardId] = useState(null);
  const [viewId, setViewId] = useState(''), [query, setQuery] = useState(''), [tag, setTag] = useState(''), [page, setPage] = useState(0);
  const root = useRef(null), title = useRef(null), initializedView = useRef(false);
  useEffect(() => {
    let stream;
    const connect = () => {
      stream?.close(); setConnected(false);
      stream = new EventSource('/api/events');
      // A reconnect is not fresh until an authoritative snapshot arrives.
      stream.onerror = () => setConnected(false);
      stream.onmessage = event => {
        try { const next = JSON.parse(event.data); setState(next); setConnected(navigator.onLine); } catch { setConnected(false); }
      };
    };
    const offline = () => { stream?.close(); setConnected(false); };
    if (navigator.onLine) connect();
    window.addEventListener('offline', offline); window.addEventListener('online', connect);
    return () => { stream?.close(); window.removeEventListener('offline', offline); window.removeEventListener('online', connect); };
  }, []);
  useEffect(() => {
    if (!initializedView.current && state.cardBox) { initializedView.current = true; setViewId(state.cardBox.activeViewId); }
  }, [state.cardBox]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      root.current?.style.setProperty('--mobile-height', `${viewport?.height ?? innerHeight}px`);
      root.current?.style.setProperty('--mobile-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => { title.current?.focus(); }, [tab, agentId, cardId]);
  // Prevent browser navigation on a file drop; never mount an upload listener.
  useEffect(() => {
    const prevent = event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  const agent = mobileAgent(state, agentId);
  const card = state.cards.find(card => card.id === cardId);
  const shown = useMemo(() => mobileCards(state.cards, state.cardBox, viewId, query, tag), [state.cards, state.cardBox, viewId, query, tag]);
  const tags = useMemo(() => [...new Map(state.cards.flatMap(card => card.tags).map(tag => [normalizeTag(tag), tag])).values()].sort(), [state.cards]);
  const pageCount = Math.max(1, Math.ceil(shown.length / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const detail = tab === 'board' ? !!agentId : !!cardId;
  const filterTag = value => { setTag(value); setQuery(''); setViewId(''); setPage(0); setCardId(null); };
  return <div className="mobile-app" ref={root}>
    <header className="mobile-header">
      {detail && <button type="button" aria-label={tab === 'board' ? 'Back to Board' : 'Back to Cards'} onClick={() => tab === 'board' ? setAgentId(null) : setCardId(null)}>←</button>}
      <h1 ref={title} tabIndex={-1}>{tab === 'board' ? agentId ? agent?.name || 'Agent unavailable' : 'Board' : cardId ? 'Card' : 'Cards'}</h1>
      <span className={connected ? 'mobile-connected' : 'mobile-offline'} role="status">{connected ? '● Live' : '○ Disconnected'}</span>
    </header>
    {!connected && <p className="mobile-warning" role="status">Waiting for live updates · displayed data may be outdated</p>}
    <main className="mobile-board mobile-list" hidden={tab !== 'board' || !!agentId}>
      {!state.scoreboard.length && <p>No running Agent Canvas agents.</p>}
      <ul>{state.scoreboard.map(row => <li key={row.id}><button type="button" disabled={!connected} data-agent-id={row.id} onClick={() => setAgentId(row.id)}>
        <span className="mobile-agent-name">{row.name}</span><span className={`mobile-agent-status ${row.status}`}>{row.status}</span>
        <span className="mobile-agent-progress">{row.progress}</span>
      </button></li>)}</ul>
    </main>
    {tab === 'board' && agentId && <div className="mobile-agent-detail">
      <p className="mobile-agent-summary">{agent?.status === 'running' ? ['working', 'idle'].includes(agent.activity) ? agent.activity : 'running' : agent?.status || 'Agent removed'}{agent?.note && <> · {agent.note}</>}</p>
      {agent?.status === 'running' && agent.processGeneration
        ? <MobileTerminal key={`${agent.id}:${agent.processGeneration}`} id={agent.id} generation={agent.processGeneration} connected={connected} />
        : <p role="status">This Agent is no longer running. Return to Board to choose another.</p>}
    </div>}
    <main className="mobile-cards mobile-list" hidden={tab !== 'cards' || !!cardId}>
      <p>Read only</p>
      <label>View<select aria-label="Browse view" value={viewId} onChange={event => { setViewId(event.target.value); setPage(0); }}>
        <option value="">All cards</option>
        {!!viewId && !state.cardBox?.views.some(view => view.id === viewId) && <option value={viewId}>View unavailable</option>}
        {state.cardBox?.views.map(view => <option key={view.id} value={view.id}>{view.name || 'Untitled'}{!view.saved ? ' · Temporary' : ''}</option>)}
      </select></label>
      <input type="search" aria-label="Search cards" placeholder="Search cards…" maxLength={1000} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <label>Tag<select aria-label="Filter tag" value={tag} onChange={event => { setTag(event.target.value); setPage(0); }}><option value="">All tags</option>{tag && !tags.includes(tag) && <option value={tag}>{tag}</option>}{tags.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <p role="status">{shown.length} cards · matches any search word</p>
      <ul>{shown.slice(currentPage * 24, (currentPage + 1) * 24).map(card => <li key={card.id}><button type="button" className="mobile-card-preview" data-card-id={card.id} onClick={() => setCardId(card.id)}>
        {card.type === 'interactive' ? <strong>◇ {card.title}</strong> : <span>{card.content.slice(0, 240) || 'Empty card'}</span>}
        <small>{card.id} · {card.tags.join(' · ')}</small>
      </button></li>)}</ul>
      {!shown.length && <p>No matching cards.</p>}
      <nav className="mobile-pagination" aria-label="Card pages"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></nav>
    </main>
    {tab === 'cards' && cardId && <main className="mobile-reader mobile-list" key={cardId}>{card ? <CardReader card={card} onCard={setCardId} onTag={filterTag} /> : <p role="status">Card unavailable or deleted.</p>}</main>}
    <nav className="mobile-tabs" aria-label="Mobile navigation">{[['board', 'Board'], ['cards', 'Cards']].map(([value, label]) => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); if (value !== tab) { setAgentId(null); setCardId(null); } }}>{label}</button>)}</nav>
  </div>;
}
