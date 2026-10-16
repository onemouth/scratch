import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, ControlButton, Handle, NodeResizer, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, applyNodeChanges, useReactFlow, useViewport, ReactFlowProvider, useNodesInitialized } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cardAudio } from './card-audio.js';
import { WorkspaceOverview } from './workspace-overview.jsx';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Markdown from 'react-markdown';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { pasteChunks } from './terminal-paste.js';
import { correctTerminalMouseScale } from './terminal-mouse-scale.js';
import { completedAgents, notificationContent } from './agent-notifications.js';
import { includeCreatedAgent } from './agent-state.js';
import { CardNode, reconcileCardDrafts } from './cards.jsx';
import { AgentName } from './agent-name.jsx';
import { CardLibrary, ViewControls } from './card-views.jsx';
import { mergeViewResponse, mergeViewSnapshot, nodeMeasurement as measuredLike } from './card-view-state.js';
import { cardsWithExactTag, recursivelyLinkedCards, uniqueViewName } from './card-view-explore.js';

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function PtyTerminal({ id, stopped, focusRequest }) {
  const [ready, setReady] = useState(false);
  const focusedRequest = React.useRef(0);
  const container = React.useRef(null);
  const termRef = React.useRef(null);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, lineHeight: 1.25, theme: { background: '#101927', foreground: '#d1dcec', cursor: '#a5a7fa' }, scrollback: 3000, allowProposedApi: false });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    correctTerminalMouseScale(terminal);
    termRef.current = terminal;
    let socket;
    let retry;
    let alive = true;
    const send = (value) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const resize = () => { if (container.current?.clientWidth && container.current?.clientHeight) { fit.fit(); send({ type: 'resize', cols: terminal.cols, rows: terminal.rows }); } };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData(data => send({ type: 'input', data }));
    const element = container.current;
    const onPaste = event => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData.getData('text/plain');
      if (!text || socket?.readyState !== WebSocket.OPEN) return;
      for (const data of pasteChunks(text)) send({ type: 'input', data });
    };
    // Capture before xterm handles paste, preventing duplicate input and relying
    // on neither initial terminal setup bytes nor truncated output replay.
    element.addEventListener('paste', onPaste, true);
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/${id}`);
      socket.onopen = () => { terminal.reset(); resize(); if (alive) setReady(true); };
      socket.onmessage = event => terminal.write(event.data);
      socket.onclose = () => { if (alive) { setReady(false); retry = setTimeout(connect, 1500); } };
    };
    connect();
    return () => { alive = false; clearTimeout(retry); socket?.close(); element.removeEventListener('paste', onPaste, true); observer.disconnect(); input.dispose(); terminal.dispose(); termRef.current = null; };
  }, [id]);
  useEffect(() => {
    if (!ready || stopped || !focusRequest || focusedRequest.current === focusRequest) return;
    let frame;
    let attempts = 0;
    const focus = () => {
      // React Flow initially hides unmeasured nodes; focusing their textarea
      // before layout succeeds silently but leaves keyboard focus on the page.
      if (container.current && getComputedStyle(container.current).visibility !== 'hidden') {
        termRef.current?.focus();
        if (document.activeElement === termRef.current?.textarea) {
          focusedRequest.current = focusRequest;
          return;
        }
      }
      if (++attempts < 120) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [ready, stopped, focusRequest]);
  useEffect(() => { if (stopped) termRef.current?.blur(); }, [stopped]);
  return <div className="terminal nodrag nowheel" ref={container} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} />;
}

function AgentNode({ id, data, selected }) {
  const agent = data.agent;
  const [error, setError] = useState('');
  const { x, y, zoom } = useViewport();
  const [windowSize, setWindowSize] = useState(() => ({ width: innerWidth, height: innerHeight }));
  useEffect(() => {
    if (!data.maximized) return;
    const resize = () => setWindowSize({ width: innerWidth, height: innerHeight });
    window.addEventListener('resize', resize);
    resize();
    return () => window.removeEventListener('resize', resize);
  }, [data.maximized]);
  // React Flow transforms both the viewport and the node. Cancel those transforms
  // only for this window; the saved node layout and the terminal DOM stay intact.
  const maximizeStyle = data.maximized && data.docked ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 10001 } : data.maximized ? {
    position: 'absolute', left: -x / zoom - data.position.x, top: -y / zoom - data.position.y,
    width: windowSize.width, height: windowSize.height, transform: `scale(${1 / zoom})`, transformOrigin: 'top left',
  } : undefined;
  const stop = async () => { try { await api(`/agents/${id}/stop`, 'POST'); } catch (e) { setError(e.message); } };
  const remove = async () => {
    try { await api(`/agents/${id}`, 'DELETE'); } catch (e) { setError(e.message); }
  };
  return <>
    <NodeResizer isVisible={!data.docked && !!selected && !data.maximized} minWidth={320} minHeight={240} onResizeEnd={(_, p) => api(`/agents/${id}`, 'PATCH', { x: p.x, y: p.y, width: p.width, height: p.height }).catch(e => setError(e.message))} />
    <div className={`agent-node ${agent.status}${data.maximized ? ' maximized' : ''}`} style={maximizeStyle}>
    {!data.cardBox && <Handle type="target" position={Position.Left} />}
    <header className="node-header">
      <span className="status-dot" /><AgentName id={agent.id} name={agent.name} onError={setError} /><span className="badge">{agent.status}</span>
      <button type="button" className="icon-btn nodrag" title={data.maximized ? 'Return to whiteboard' : 'Maximize agent'} aria-label={data.maximized ? `Return ${agent.name} to whiteboard` : `Maximize ${agent.name}`} onClick={() => data.onMaximize(data.maximized ? null : id)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{data.maximized ? <><path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4" /><rect x="8" y="8" width="8" height="8" /></> : <rect x="4" y="4" width="16" height="16" rx="1" />}</svg></button>
      {data.docked && !data.maximized && <button type="button" className="icon-btn nodrag" title="Hide agent sidebar" aria-label="Hide agent sidebar" onClick={data.onHide}>→</button>}
      {agent.status === 'running' && <button className="icon-btn nodrag" title="Stop agent" aria-label={`Stop ${agent.name}`} onClick={stop}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg></button>}
      {agent.status === 'stopped' && <button className="icon-btn nodrag" title="Reopen conversation (no task sent)" aria-label={`Resume ${agent.name}`} onClick={() => api(`/agents/${id}/resume`, 'POST').then(() => data.onFocus(id)).catch(e => setError(e.message))}>▶</button>}
      {agent.status === 'stopped' && !data.cardBox && <button className="icon-btn nodrag" title="Remove node from canvas" aria-label={`Remove ${agent.name} from canvas`} onClick={remove}>×</button>}
    </header>
    <div className="node-subtitle" title={agent.workdir}>{agent.workdir}</div>
    {agent.note && <div className="node-note" title={agent.note}>{agent.note}</div>}
    <PtyTerminal id={id} stopped={agent.status === 'stopped'} focusRequest={data.maximized ? `maximized-${data.maximizeFocus}` : data.focusRequest} />
    {agent.restoreWarning && <div className="node-error">{agent.restoreWarning}</div>}
    {error && <div className="node-error">{error}</div>}
    {!data.cardBox && <Handle type="source" position={Position.Right} />}
    </div>
  </>;
}

function StickyNote({ id, data, selected }) {
  const { zoom } = useViewport();
  // Keep at least 14 screen pixels of text while the paper follows canvas zoom.
  const fontSize = Math.max(16, 14 / zoom);
  const [text, setText] = useState(data.note.text);
  const [error, setError] = useState('');
  const dirty = React.useRef(false);
  useEffect(() => { if (!dirty.current) setText(data.note.text); }, [data.note.text]);
  const save = async () => {
    if (!dirty.current) return;
    try { await api(`/notes/${id}`, 'PATCH', { text }); dirty.current = false; setError(''); }
    catch (e) { setError(e.message); }
  };
  return <>
    <NodeResizer isVisible={selected} minWidth={160} minHeight={160} onResizeEnd={(_, p) => api(`/notes/${id}`, 'PATCH', { x: p.x, y: p.y, width: p.width, height: p.height }).catch(e => setError(e.message))} />
    <div className="sticky-note" style={{ fontSize }}>
    <div className="note-drag-handle" title="Drag to move note" />
    <button className="note-delete icon-btn nodrag" aria-label="Delete note" onClick={() => api(`/notes/${id}`, 'DELETE').catch(e => setError(e.message))}>×</button>
    <textarea className="nodrag nowheel" aria-label="Note text" placeholder="Write a note…" maxLength={10000} value={text} onChange={e => { dirty.current = true; setText(e.target.value); }} onBlur={save} />
    {error && <div role="alert">{error}<button className="nodrag" onClick={save}>Retry save</button></div>}
    </div>
  </>;
}
const nodeTypes = { agent: AgentNode, note: StickyNote, card: CardNode };

function DelegationEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = React.useRef(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const save = async () => {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; return; }
    const label = draft.trim() || 'delegates';
    if (label !== data.label) {
      try { await api(`/edges/${id}`, 'PATCH', { label }); }
      catch (e) { data.onError(e.message); }
    }
  };
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: '#8aa3e8', strokeWidth: 2 }} />
    <EdgeLabelRenderer><div className="edge-label-wrap nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {editing
        ? <input className="edge-label-input" autoFocus maxLength={120} aria-label="Delegation label" value={draft} onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={save} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); } }} />
        : <button type="button" className="edge-label-button" title="Click to edit label" onClick={() => { setDraft(data.label); setEditing(true); }}>{data.label}</button>}
    </div></EdgeLabelRenderer>
  </>;
}

const edgeTypes = { delegates: DelegationEdge };

function Canvas() {
  const [state, setState] = useState({ agents: [], edges: [] });
  const [nodes, setNodes] = useState([]);
  const [maximizedId, setMaximizedId] = useState(null);
  const [maximizeFocus, setMaximizeFocus] = useState(0);
  const maximizeNode = useCallback(id => { setMaximizedId(id); if (id) setMaximizeFocus(n => n + 1); }, []);
  const [form, setForm] = useState({ name: '', workdir: '', mode: 'new' });
  const [open, setOpen] = useState(false);
  const [savedWorkdirs, setSavedWorkdirs] = useState([]);
  const [workdirsLoading, setWorkdirsLoading] = useState(false);
  const [workdirsError, setWorkdirsError] = useState('');
  const [docsOpen, setDocsOpen] = useState(false);
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('agent-canvas:workspace') === 'card-box' ? 'card-box' : 'agents'; } catch { return 'agents'; }
  });
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [agentSidebarOpen, setAgentSidebarOpen] = useState(() => {
    try { return localStorage.getItem('agent-canvas:card-box-agent-sidebar') !== 'hidden'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('agent-canvas:card-box-agent-sidebar', agentSidebarOpen ? 'open' : 'hidden'); } catch {}
  }, [agentSidebarOpen]);
  const mergeBox = useCallback(cardBox => setState(current => mergeViewResponse(current, cardBox)), []);
  useEffect(() => { cardAudio.reconcile(state.cards || []); reconcileCardDrafts(state.cards || []); }, [state.cards]);
  useEffect(() => {
    // Ignore files dropped outside a card without letting the browser navigate.
    const prevent = event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const [exploreRequest, setExploreRequest] = useState(null);
  const exploreSequence = React.useRef(0);
  const exploreTag = useCallback(tag => {
    const current = stateRef.current, cardIds = cardsWithExactTag(current.cards || [], tag);
    setExploreRequest({ id: ++exploreSequence.current, name: uniqueViewName(`Tag: ${tag}`, current.cardBox?.views || []), cardIds });
  }, []);
  const exploreLink = useCallback((sourceId, linkedId) => {
    const current = stateRef.current, cardIds = recursivelyLinkedCards(current.cards || [], sourceId, linkedId);
    setExploreRequest({ id: ++exploreSequence.current, name: uniqueViewName(`Linked: ${linkedId}`, current.cardBox?.views || []), cardIds });
  }, []);
  const initialized = useNodesInitialized();
  const viewportByMode = React.useRef({});
  const appliedMode = React.useRef(null);
  const applyingViewport = React.useRef(false);
  const appliedViewport = React.useRef(null);
  const viewportSequence = React.useRef(0);
  const viewportGesture = React.useRef(null);
  const fitViewRequest = React.useRef(null);
  const pendingViewports = React.useRef(new Map());
  const dragTargets = React.useRef(new Map());
  const restorePlacement = useCallback((id, p) => {
    if (p) setNodes(items => items.map(n => n.id !== id ? n : { ...n, dragging: false, position: { x: p.x, y: p.y }, width: p.width, height: p.height, style: { ...n.style, width: p.width, height: p.height } }));
  }, []);
  useEffect(() => { try { localStorage.setItem('agent-canvas:workspace', mode); } catch {} }, [mode]);
  const [guide, setGuide] = useState('');
  const [docsError, setDocsError] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    try { return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem('agent-canvas:notifications') === 'on'; }
    catch { return false; }
  });
  const notificationsRef = React.useRef(notificationsEnabled);
  notificationsRef.current = notificationsEnabled;
  const toggleNotifications = async () => {
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      try { localStorage.setItem('agent-canvas:notifications', 'off'); } catch { /* Optional preference. */ }
      return;
    }
    if (typeof Notification === 'undefined') { setError('This browser does not support desktop notifications.'); return; }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setError('Allow notifications for this site in your browser settings to enable alerts.'); return; }
      try { localStorage.setItem('agent-canvas:notifications', 'on'); } catch { /* Allow alerts for this tab even without storage. */ }
      setNotificationsEnabled(true);
    } catch { setError('Could not enable browser notifications.'); }
  };
  const [pointerMode, setPointerMode] = useState(() => {
    try { return localStorage.getItem('agent-canvas:pointer-mode') === 'touchpad' ? 'touchpad' : 'mouse'; }
    catch { return 'mouse'; }
  });
  useEffect(() => {
    try { localStorage.setItem('agent-canvas:pointer-mode', pointerMode); }
    catch { /* Keep controls usable when browser storage is unavailable. */ }
  }, [pointerMode]);
  const { screenToFlowPosition, setCenter, getZoom, getViewport, setViewport, fitView } = useReactFlow();
  const [focusTarget, setFocusTarget] = useState(null);
  const focusSequence = React.useRef(0);
  const centeredRequest = React.useRef(0);
  const focusAgent = useCallback((id, workspace) => {
    const agent = stateRef.current.agents.find(agent => agent.id === id);
    const cardBox = (workspace || agent?.workspace) === 'card-box';
    setMode(cardBox ? 'card-box' : 'agents');
    if (cardBox) setAgentSidebarOpen(true);
    setFocusTarget({ id, request: ++focusSequence.current });
  }, []);
  const switchMode = () => { setMaximizedId(null); setFocusTarget(null); setMode(value => value === 'agents' ? 'card-box' : 'agents'); };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setWorkdirsLoading(true); setWorkdirsError('');
    api('/session-workdirs').then(({ workdirs }) => { if (active) setSavedWorkdirs(workdirs); })
      .catch(e => { if (active) setWorkdirsError(e.message); })
      .finally(() => { if (active) setWorkdirsLoading(false); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!docsOpen || guide) return;
    let active = true;
    fetch(`/api/docs?origin=${encodeURIComponent(location.origin)}`).then(async response => {
      if (!response.ok) throw new Error(`Could not load guide (${response.status})`);
      return response.text();
    }).then(text => { if (active) { setGuide(text); setDocsError(''); } }).catch(e => { if (active) setDocsError(e.message); });
    return () => { active = false; };
  }, [docsOpen, guide]);
  const copyGuide = async () => {
    try { await navigator.clipboard.writeText(guide); setCopied(true); setDocsError(''); setTimeout(() => setCopied(false), 2000); }
    catch { setDocsError('Could not copy automatically. Open the Markdown link below and copy it manually.'); }
  };
  useEffect(() => {
    const stream = new EventSource('/api/events');
    let knownAgents = null;
    let previousActivity = null;
    stream.onopen = () => { knownAgents = null; previousActivity = null; setConnected(true); };
    stream.onerror = () => setConnected(false);
    stream.onmessage = (e) => {
      const next = JSON.parse(e.data);
      const added = knownAgents && next.agents.filter(agent => !knownAgents.has(agent.id));
      if (notificationsRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        for (const agent of completedAgents(previousActivity, next.agents)) {
          const activeNode = document.activeElement?.closest?.('.react-flow__node-agent, .card-box-agent-sidebar');
          if (document.hasFocus() && activeNode?.getAttribute('data-id') === agent.id) continue;
          try {
            const content = notificationContent(agent);
            const notification = new Notification(content.title, { body: content.body, tag: `agent-canvas:${agent.id}` });
            notification.onclick = () => {
              window.focus();
              // Keep maximized mode when navigating from a notification.
              setMaximizedId(current => current ? agent.id : null);
              setMaximizeFocus(n => n + 1);
              focusAgent(agent.id, agent.workspace);
              notification.close();
            };
          } catch { /* Browser notification service may be unavailable. */ }
        }
      }
      previousActivity = new Map(next.agents.map(agent => [agent.id, agent.activity]));
      knownAgents = new Set(next.agents.map(agent => agent.id));
      setState(current => mergeViewSnapshot(current, next));
      setMaximizedId(id => {
        if (!id) return null;
        const live = next.agents.some(agent => agent.id === id) || (next.cardPlacements || []).some(placement => placement.id === id) ||
          (next.cardBox?.placements || []).some(placement => `card-box-${placement.id}` === id);
        return live ? id : null;
      });
      // Initial load/reconnect does not steal focus; live API-created agents do.
      if (added?.length) focusAgent(added.at(-1).id, added.at(-1).workspace);
    };
    return () => stream.close();
  }, [focusAgent]);
  useEffect(() => {
    const systemView = state.cardBox?.views?.find(view => view.id === state.cardBox.activeViewId)?.system;
    setNodes(previous => {
      const byId = new Map(previous.map(n => [n.id, n]));
      return [...state.agents.filter(agent => agent.workspace !== 'card-box').map(agent => {
        const old = byId.get(agent.id);
        return {
          id: agent.id, type: 'agent', measured: measuredLike(old, agent.width, agent.height), dragging: old?.dragging, position: old?.dragging ? old.position : { x: agent.x, y: agent.y },
          style: { width: agent.width, height: agent.height, visibility: ((agent.workspace === 'card-box') === (mode === 'card-box')) ? 'visible' : 'hidden', pointerEvents: ((agent.workspace === 'card-box') === (mode === 'card-box')) ? 'auto' : 'none' }, zIndex: maximizedId === agent.id ? 10000 : undefined,
          data: { agent, cardBox: agent.workspace === 'card-box', workspace: agent.workspace === 'card-box' ? 'card-box' : 'agents', position: old?.dragging ? old.position : { x: agent.x, y: agent.y }, maximized: maximizedId === agent.id, onMaximize: maximizeNode, maximizeFocus, onFocus: focusAgent, focusRequest: !open && !docsOpen && focusTarget?.id === agent.id ? focusTarget.request : 0 }, selected: old?.selected,
        };
      }), ...(state.notes || []).map(note => {
        const old = byId.get(note.id);
        return { id: note.id, type: 'note', measured: measuredLike(old, note.width, note.height), dragging: old?.dragging, dragHandle: '.note-drag-handle', position: old?.dragging ? old.position : { x: note.x, y: note.y }, style: { width: note.width, height: note.height, visibility: mode === 'agents' ? 'visible' : 'hidden', pointerEvents: mode === 'agents' ? 'auto' : 'none' }, data: { note, workspace: 'agents' }, selected: old?.selected };
      }), ...(state.cardPlacements || []).flatMap(placement => {
        const card = (state.cards || []).find(card => card.id === placement.cardId);
        if (!card) return [];
        const old = byId.get(placement.id), position = old?.dragging ? old.position : { x: placement.x, y: placement.y };
        return [{ id: placement.id, type: 'card', measured: measuredLike(old, placement.width, placement.height), dragging: old?.dragging, dragHandle: '.card-drag-handle', position, style: { width: placement.width, height: placement.height, visibility: mode === 'agents' ? 'visible' : 'hidden', pointerEvents: mode === 'agents' ? 'auto' : 'none' }, zIndex: maximizedId === placement.id ? 10000 : undefined, data: { card, placement, restorePlacement, workspace: 'agents', position, maximized: maximizedId === placement.id, onMaximize: maximizeNode }, selected: old?.selected }];
      }), ...(state.cardBox?.placements || []).flatMap(placement => {
        const card = (state.cards || []).find(card => card.id === placement.cardId);
        if (!card) return [];
        const id = `card-box-${placement.id}`, old = byId.get(id);
        const dragging = old?.dragging && old.data.viewId === state.cardBox.activeViewId;
        const position = dragging ? old.position : { x: placement.x, y: placement.y };
        return [{ id, type: 'card', measured: measuredLike(old, placement.width, placement.height), dragging, dragHandle: '.card-drag-handle', position, style: { width: placement.width, height: placement.height, visibility: mode === 'card-box' ? 'visible' : 'hidden', pointerEvents: mode === 'card-box' ? 'auto' : 'none' }, zIndex: maximizedId === id ? 10000 : undefined, data: { card, placement, restorePlacement, cardBox: true, viewId: state.cardBox.activeViewId, systemView, onExploreTag: exploreTag, onExploreLink: exploreLink, inAgentCanvas: (state.cardPlacements || []).some(item => item.cardId === card.id), workspace: 'card-box', position, maximized: maximizedId === id, onMaximize: maximizeNode }, selected: old?.selected }];
      })];
    });
  }, [mode, state.cardBox, state.agents, state.notes, state.cards, state.cardPlacements, focusTarget, open, docsOpen, focusAgent, exploreTag, exploreLink, maximizedId, maximizeNode, maximizeFocus]);
  useEffect(() => {
    const docked = mode === 'card-box' && state.agents.some(agent => agent.id === maximizedId && agent.workspace === 'card-box');
    if (maximizedId && !docked && !nodes.some(node => node.id === maximizedId && node.data.workspace === mode)) setMaximizedId(null);
  }, [maximizedId, nodes, mode, state.agents]);
  const persistViewport = useCallback(async (id, viewport) => {
    if (!id) return;
    pendingViewports.current.set(id, (pendingViewports.current.get(id) || 0) + 1);
    try { mergeBox(await api('/card-box/views/' + id + '/viewport', 'PATCH', viewport)); }
    finally {
      const remaining = pendingViewports.current.get(id) - 1;
      if (remaining) pendingViewports.current.set(id, remaining); else pendingViewports.current.delete(id);
    }
  }, [mergeBox]);
  useEffect(() => {
    const box = state.cardBox;
    const key = mode === 'card-box' ? 'card-box:' + box?.activeViewId : 'agents';
    if ((!initialized && nodes.length) || !nodes.every(node => (node.style.visibility === 'visible') === (node.data.workspace === mode)) || nodes.some(n => n.data.cardBox && n.type === 'card' && n.data.viewId !== box?.activeViewId)) return;
    const active = box?.views?.find(v => v.id === box.activeViewId);
    const target = mode === 'card-box' ? active?.viewport : viewportByMode.current.agents;
    const current = getViewport();
    const same = target && ['x','y','zoom'].every(k => Math.abs(target[k] - current[k]) < 0.001);
    // Do not snap a local pan/zoom/fit back to an earlier SSE viewport while
    // that gesture or its acknowledgement is still in progress.
    if (mode === 'card-box' && appliedMode.current === key && (viewportGesture.current === box?.activeViewId || pendingViewports.current.has(box?.activeViewId))) return;
    const signature = JSON.stringify(target ?? null);
    if (appliedMode.current === key && appliedViewport.current === signature) return;
    if (appliedMode.current === key && same) { appliedViewport.current = signature; return; }
    if (appliedMode.current === 'agents') viewportByMode.current.agents = current;
    const switched = appliedMode.current !== key;
    appliedMode.current = key;
    appliedViewport.current = signature;
    const sequence = ++viewportSequence.current;
    const fitCreated = mode === 'card-box' && fitViewRequest.current === box?.activeViewId;
    applyingViewport.current = true;
    let operation;
    if (fitCreated) operation = fitView({ nodes: nodes.filter(node => node.type === 'card' && node.data.viewId === box.activeViewId).map(node => ({ id: node.id })), padding: 0.2 });
    else if (target) operation = setViewport(target);
    else if (!focusTarget && switched && mode === 'card-box' && !active?.saved) operation = setViewport({ x: 0, y: 0, zoom: 1 });
    else if (!focusTarget && switched) operation = fitView({ nodes: nodes.filter(node => node.data.workspace === mode).map(node => ({ id: node.id })), padding: 0.3 });
    Promise.resolve(operation).then(() => {
      if (sequence !== viewportSequence.current) return;
      applyingViewport.current = false;
      if (fitCreated && fitViewRequest.current === box.activeViewId) {
        fitViewRequest.current = null;
        persistViewport(box.activeViewId, getViewport()).catch(e => setError(e.message));
      }
    }, () => { if (sequence === viewportSequence.current) applyingViewport.current = false; });
  }, [mode, state.cardBox, nodes, initialized, focusTarget, fitView, getViewport, setViewport, persistViewport]);
  const beforeViewSwitch = useCallback(async id => {
    if (mode === 'card-box' && stateRef.current.cardBox?.activeViewId === id && appliedMode.current === 'card-box:' + id && !applyingViewport.current) await persistViewport(id, getViewport());
  }, [mode, persistViewport, getViewport]);
  const onMoveStart = useCallback(() => {
    if (mode === 'card-box' && !applyingViewport.current) viewportGesture.current = stateRef.current.cardBox?.activeViewId;
  }, [mode]);
  const onMoveEnd = useCallback((_, viewport) => {
    if (mode !== 'card-box' || applyingViewport.current) return;
    const source = viewportGesture.current; viewportGesture.current = null;
    const box = stateRef.current.cardBox, view = box?.views?.find(v => v.id === box.activeViewId);
    if (source && source !== box?.activeViewId) {
      const sequence = ++viewportSequence.current; applyingViewport.current = true;
      setViewport(view?.viewport ?? { x: 0, y: 0, zoom: 1 }).finally(() => { if (sequence === viewportSequence.current) applyingViewport.current = false; });
      return;
    }
    if (view?.viewport && ['x','y','zoom'].every(k => Math.abs(view.viewport[k] - viewport[k]) < 0.001)) return;
    persistViewport(box?.activeViewId, viewport).catch(e => setError(e.message));
  }, [mode, persistViewport, setViewport]);
  useEffect(() => {
    if (!focusTarget || open || docsOpen || centeredRequest.current === focusTarget.request) return;
    const node = nodes.find(node => node.id === focusTarget.id);
    if (!node || node.data.workspace !== mode) return;
    centeredRequest.current = focusTarget.request;
    setNodes(previous => previous.map(item => ({ ...item, selected: item.id === node.id })));
    // Center within the currently visible viewport, not at canvas origin;
    // preserve the user's current zoom level while bringing the node into view.
    setCenter(node.position.x + node.style.width / 2, node.position.y + node.style.height / 2, { zoom: getZoom(), duration: 200 });
  }, [nodes, mode, focusTarget, open, docsOpen, setCenter, getZoom]);
  const onNodesChange = useCallback(changes => setNodes(ns => applyNodeChanges(changes, ns)), []);
  const onNodeDragStart = useCallback((_, node) => { dragTargets.current.set(node.id, node.data.viewId); }, []);
  const onNodeDragStop = useCallback((_, node) => {
    const source = dragTargets.current.get(node.id); dragTargets.current.delete(node.id);
    if (node.type === 'card' && node.data.cardBox && source !== stateRef.current.cardBox?.activeViewId) { restorePlacement(node.id, stateRef.current.cardBox?.placements.find(p => p.id === node.data.card.id)); return; }
    const path = node.type === 'card' ? (node.data.cardBox ? (source ? `/card-box/views/${source}/cards/${node.data.card.id}` : `/card-box/placements/${node.data.card.id}`) : `/card-placements/${node.data.card.id}`) : `/${node.type === 'note' ? 'notes' : 'agents'}/${node.id}`;
    api(path, 'PATCH', { x: node.position.x, y: node.position.y }).catch(e => setError(e.message));
  }, [restorePlacement]);
  const onConnect = useCallback(async ({ source, target }) => { try { await api('/edges', 'POST', { source, target }); } catch (e) { setError(e.message); } }, []);
  const edges = useMemo(() => mode === 'card-box' ? [] : state.edges.map(edge => ({ ...edge, data: { label: edge.label || 'delegates', onError: setError }, markerEnd: { type: 'arrowclosed', color: '#8aa3e8' } })), [state.edges, mode]);
  const resetCanvas = async () => {
    if (!confirm('Reset Agent Canvas? This stops its agents and removes its nodes, notes, and connections. Card box agent, layout and cards are preserved. Pi sessions and project files are NOT deleted. Running work will be interrupted.')) return;
    try { await api('/canvas/reset', 'POST', { confirm: true }); setError(''); }
    catch (e) { setError(e.message); }
  };
  const openLaunch = () => { setError(''); setOpen(true); };
  const createCard = async () => {
    try {
      const card = await api('/cards', 'POST', { content: '', tags: [], place: mode !== 'card-box' });
      if (mode === 'card-box') return;
      const position = screenToFlowPosition({ x: innerWidth / 2, y: innerHeight / 2 });
      await api(`/card-placements/${card.id}`, 'PATCH', { x: position.x - 170, y: position.y - 160 });
    } catch (e) { setError(e.message); }
  };
  const launchBoxAgent = async () => {
    try {
      const agent = await api('/card-box/agent', 'POST', {});
      setState(current => includeCreatedAgent(current, agent));
      focusAgent(agent.id, 'card-box');
    }
    catch (e) { setError(e.message); }
  };
  const createNote = async () => {
    const position = screenToFlowPosition({ x: innerWidth / 2 - 140, y: innerHeight / 2 - 110 });
    try { await api('/notes', 'POST', position); } catch (e) { setError(e.message); }
  };
  const create = async (e) => {
    e.preventDefault(); setError('');
    try {
      const position = screenToFlowPosition({ x: innerWidth / 2 - 210, y: innerHeight / 2 - 160 });
      const agent = await api('/agents', 'POST', { ...form, x: position.x, y: position.y });
      setState(current => includeCreatedAgent(current, agent));
      focusAgent(agent.id);
      setForm(f => ({ ...f, name: '' })); setOpen(false);
    } catch (err) { setError(err.message); }
  };
  const boxAgent = state.agents.find(agent => agent.workspace === 'card-box');
  const boxAgentMaximized = !!boxAgent && maximizedId === boxAgent.id;
  return <div className={`app${maximizedId ? ' is-maximized' : ''}`}>
    <div className={`topbar${mode === 'card-box' ? ' has-view-controls' : ''}`}>
      <div className="workspace-nav"><div className="brand"><span className="brand-icon">✳</span> {mode === 'card-box' ? 'Card box' : 'Agent Canvas'} <small>PI WORKSPACE</small></div><button type="button" className="guide-button" onClick={switchMode}>{mode === 'agents' ? 'Card box' : 'Agent Canvas'}</button></div>
      {mode === 'card-box' && <ViewControls box={state.cardBox} libraryOpen={libraryOpen} onLibrary={() => setLibraryOpen(v => !v)} onChange={mergeBox} onError={setError} beforeSwitch={beforeViewSwitch} exploreRequest={exploreRequest} onExploreCreated={id => { fitViewRequest.current = id; }} />}
      <div className="top-actions">{mode === 'card-box' && boxAgent && <button type="button" className="guide-button" aria-label={agentSidebarOpen ? 'Hide Card box agent' : 'Show Card box agent'} aria-expanded={agentSidebarOpen} aria-controls="card-box-agent-sidebar" onClick={() => setAgentSidebarOpen(value => !value)}>Agent {agentSidebarOpen ? '→' : '←'}</button>}<span className={`connection ${connected ? '' : 'offline'}`}>{connected ? '● Connected' : '○ Reconnecting'}</span><button className="guide-button notification-toggle" type="button" aria-label={notificationsEnabled ? 'Disable browser notifications' : 'Enable browser notifications'} title={notificationsEnabled ? 'Browser notifications on · click to turn off' : 'Browser notifications off · click to enable'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9M10 21h4" />{!notificationsEnabled && <path d="M3 3l18 18" />}</svg></button>{mode === 'agents' && <button className="guide-button" onClick={resetCanvas}>Reset Canvas</button>}<button className="guide-button" onClick={() => setDocsOpen(true)}>API Guide</button><button className="guide-button" onClick={createCard}>＋ Card</button>{mode === 'agents' ? <><button className="guide-button" onClick={createNote}>＋ Note</button><button className="primary" onClick={openLaunch}>＋ New agent</button></> : !state.agents.some(agent => agent.workspace === 'card-box') && <button className="primary" onClick={launchBoxAgent}>Start Card box agent</button>}</div>
    </div>
    {mode === 'card-box' && libraryOpen && <CardLibrary cards={state.cards || []} box={state.cardBox} onChange={mergeBox} onClose={() => setLibraryOpen(false)} />}
    {boxAgent && <aside id="card-box-agent-sidebar" className={`card-box-agent-sidebar${boxAgentMaximized ? ' is-maximized' : ''}`} data-id={boxAgent.id} aria-label="Card box agent" style={{ display: mode === 'card-box' && (agentSidebarOpen || boxAgentMaximized) && (!maximizedId || boxAgentMaximized) ? undefined : 'none' }}>
      <AgentNode id={boxAgent.id} data={{ agent: boxAgent, cardBox: true, docked: true, onHide: () => setAgentSidebarOpen(false), maximized: boxAgentMaximized, onMaximize: maximizeNode, maximizeFocus, onFocus: focusAgent, focusRequest: mode === 'card-box' && agentSidebarOpen && !open && !docsOpen && focusTarget?.id === boxAgent.id ? focusTarget.request : 0 }} />
    </aside>}
    <div className={`flow-area${mode === 'card-box' && state.cardBox?.views ? ' box-flow' : ''}${mode === 'card-box' && libraryOpen ? ' with-library' : ''}${mode === 'card-box' && boxAgent && agentSidebarOpen ? ' with-agent-sidebar' : ''}`}>
    <ReactFlow onMoveStart={onMoveStart} onMoveEnd={onMoveEnd} proOptions={{ hideAttribution: true }} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onConnect={onConnect} onEdgeClick={async (_, edge) => { if (confirm('Remove this delegation relationship?')) await api(`/edges/${edge.id}`, 'DELETE').catch(e => setError(e.message)); }} panOnDrag={!maximizedId && (pointerMode === 'mouse' ? [2] : true)} panOnScroll={!maximizedId && pointerMode === 'touchpad'} panOnScrollSpeed={1} zoomOnScroll={!maximizedId && pointerMode === 'mouse'} zoomOnPinch={!maximizedId} nodesDraggable={!maximizedId} nodesConnectable={!maximizedId && mode === 'agents'} zoomOnDoubleClick={false} onPaneContextMenu={e => e.preventDefault()} minZoom={0.2} maxZoom={2} connectionLineStyle={{ stroke: '#8aa3e8', strokeWidth: 2 }}>
      <Background color="#243148" gap={24} size={1} />
      <Controls fitViewOptions={{ nodes: nodes.filter(node => node.data.workspace === mode).map(node => ({ id: node.id })), padding: 0.3 }}>
        <ControlButton className="pointer-toggle" aria-label={`Pointer mode: ${pointerMode === 'mouse' ? 'Mouse' : 'Touchpad'}. Click to switch to ${pointerMode === 'mouse' ? 'Touchpad' : 'Mouse'}`} title={pointerMode === 'mouse' ? 'Mouse · Right-drag to pan, wheel to zoom · Click for Touchpad' : 'Touchpad · Two-finger scroll to pan, pinch to zoom · Click for Mouse'} onClick={() => setPointerMode(mode => mode === 'mouse' ? 'touchpad' : 'mouse')}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">{pointerMode === 'mouse' ? <><rect x="5" y="2" width="14" height="20" rx="7" /><path d="M12 2v7M5 10h14" /></> : <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 15h20" /></>}</svg></ControlButton>
      </Controls><WorkspaceOverview nodes={nodes} workspace={mode} />
    </ReactFlow></div>
    {mode === 'agents' && !state.agents.some(agent => agent.workspace !== 'card-box') && !(state.notes || []).length && !(state.cardPlacements || []).length && <div className="empty"><div className="empty-icon">✳</div><h1>Space for your agents.</h1><p>Start a Pi agent, then connect agents to map real delegation.</p><button type="button" className="primary" onClick={openLaunch}>＋ Create your first agent</button><span>{pointerMode === 'mouse' ? 'Right-drag canvas to pan · Wheel to zoom' : 'Drag or two-finger scroll to pan · Pinch to zoom'}</span></div>}
    {state.persistence?.error && <div className="save-error" role="alert">Canvas is not saved: {state.persistence.error}</div>}
    {error && !open && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {docsOpen && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setDocsOpen(false); }}><section className="modal guide-modal" role="dialog" aria-modal="true" aria-label="Agent API Guide">
      <div className="modal-head"><div><small>SHARED CANVAS</small><h2>Agent API Guide</h2></div><button type="button" className="icon-btn" aria-label="Close API guide" onClick={() => setDocsOpen(false)}>×</button></div>
      <p className="guide-intro">Copy this guide into an agent to explain the Canvas API. Canvas-launched agents already receive basic instructions.</p>
      <div className="guide-content">{guide ? <Markdown>{guide}</Markdown> : docsError || 'Loading guide…'}</div>
      {docsError && guide && <div className="node-error">{docsError}</div>}
      <div className="guide-footer"><a href={`/api/docs?origin=${encodeURIComponent(location.origin)}`} target="_blank" rel="noreferrer">Open raw Markdown ↗</a><button type="button" className="primary" onClick={copyGuide} disabled={!guide}>{copied ? '✓ Copied' : 'Copy guide'}</button></div>
    </section></div>}
    {open && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}><form className="modal" onSubmit={create}>
      <div className="modal-head"><div><small>NEW SESSION</small><h2>Launch a Pi agent</h2></div><button type="button" className="icon-btn" onClick={() => setOpen(false)}>×</button></div>
      <div className="session-mode" role="group" aria-label="Pi session mode">
        <button type="button" className={form.mode === 'new' ? 'active' : ''} aria-pressed={form.mode === 'new'} onClick={() => { setForm({ ...form, mode: 'new' }); setError(''); }}>New session</button>
        <button type="button" className={form.mode === 'resume' ? 'active' : ''} aria-pressed={form.mode === 'resume'} onClick={() => { setForm({ ...form, mode: 'resume' }); setError(''); }}>Resume · pi -r</button>
      </div>
      <label>Node name<input autoFocus required maxLength="100" placeholder="e.g. Researcher" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label>Working directory<input required placeholder="/absolute/path/to/project" value={form.workdir} onChange={e => setForm({ ...form, workdir: e.target.value })} /></label>
      <label>Saved Pi session folders<select value="" disabled={workdirsLoading || savedWorkdirs.length === 0} onChange={e => setForm(f => ({ ...f, workdir: e.target.value }))}>
        <option value="">{workdirsLoading ? 'Loading saved folders…' : savedWorkdirs.length ? 'Choose a saved folder…' : 'No saved Pi session folders'}</option>
        {savedWorkdirs.map(item => <option key={item.path} value={item.path}>{item.path} ({item.sessionCount} {item.sessionCount === 1 ? 'session' : 'sessions'})</option>)}
      </select></label>
      {workdirsError && <div className="node-error">Could not load saved folders: {workdirsError}. You can still enter a path manually.</div>}
      <p className="mode-help">{form.mode === 'new'
        ? 'Pi will open a new session. Type your first instruction directly in the terminal.'
        : 'Pi will open its session picker for this working directory inside the terminal. Choose a saved session there.'}</p>
      {error && <div className="node-error">{error}</div>}
      <div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Cancel</button><button className="primary" type="submit">{form.mode === 'resume' ? 'Open session picker →' : 'Launch agent →'}</button></div>
    </form></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
