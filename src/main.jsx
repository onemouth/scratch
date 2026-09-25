import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, Handle, MiniMap, NodeResizer, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, applyNodeChanges, useReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Markdown from 'react-markdown';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { pasteChunks } from './terminal-paste.js';

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function PtyTerminal({ id, stopped }) {
  const container = React.useRef(null);
  const termRef = React.useRef(null);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, lineHeight: 1.25, theme: { background: '#101927', foreground: '#d1dcec', cursor: '#a5a7fa' }, scrollback: 3000, allowProposedApi: false });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
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
      socket.onopen = () => { terminal.reset(); resize(); };
      socket.onmessage = event => terminal.write(event.data);
      socket.onclose = () => { if (alive) retry = setTimeout(connect, 1500); };
    };
    connect();
    return () => { alive = false; clearTimeout(retry); socket?.close(); element.removeEventListener('paste', onPaste, true); observer.disconnect(); input.dispose(); terminal.dispose(); termRef.current = null; };
  }, [id]);
  useEffect(() => { if (stopped) termRef.current?.blur(); }, [stopped]);
  return <div className="terminal nodrag nowheel" ref={container} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} />;
}

function AgentNode({ id, data, selected }) {
  const agent = data.agent;
  const [error, setError] = useState('');
  const stop = async () => { try { await api(`/agents/${id}/stop`, 'POST'); } catch (e) { setError(e.message); } };
  const remove = async () => {
    try { await api(`/agents/${id}`, 'DELETE'); } catch (e) { setError(e.message); }
  };
  return <div className={`agent-node ${agent.status}`}>
    <NodeResizer isVisible={selected} minWidth={320} minHeight={240} onResizeEnd={(_, p) => api(`/agents/${id}`, 'PATCH', { width: p.width, height: p.height }).catch(console.error)} />
    <Handle type="target" position={Position.Left} />
    <header className="node-header">
      <span className="status-dot" /><strong title={agent.name}>{agent.name}</strong><span className="badge">{agent.status}</span>
      {agent.status === 'running' && <button className="icon-btn nodrag" title="Stop agent" aria-label={`Stop ${agent.name}`} onClick={stop}>■</button>}
      {agent.status === 'stopped' && <button className="icon-btn nodrag" title="Reopen conversation (no task sent)" aria-label={`Resume ${agent.name}`} onClick={() => api(`/agents/${id}/resume`, 'POST').catch(e => setError(e.message))}>▶</button>}
      {agent.status === 'stopped' && <button className="icon-btn nodrag" title="Remove node from canvas" aria-label={`Remove ${agent.name} from canvas`} onClick={remove}>×</button>}
    </header>
    <div className="node-subtitle" title={agent.workdir}>{agent.workdir}</div>
    {agent.note && <div className="node-note" title={agent.note}>{agent.note}</div>}
    <PtyTerminal id={id} stopped={agent.status === 'stopped'} />
    {agent.restoreWarning && <div className="node-error">{agent.restoreWarning}</div>}
    {error && <div className="node-error">{error}</div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}

function StickyNote({ id, data, selected }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const cancelTitle = React.useRef(false);
  const saveTitle = async () => {
    setEditingTitle(false);
    if (cancelTitle.current) { cancelTitle.current = false; return; }
    try { await api(`/notes/${id}`, 'PATCH', { title: title.trim() || 'Note' }); setError(''); }
    catch (e) { setError(e.message); }
  };
  const [text, setText] = useState(data.note.text);
  const [error, setError] = useState('');
  const dirty = React.useRef(false);
  useEffect(() => { if (!dirty.current) setText(data.note.text); }, [data.note.text]);
  const save = async () => {
    if (!dirty.current) return;
    try { await api(`/notes/${id}`, 'PATCH', { text }); dirty.current = false; setError(''); }
    catch (e) { setError(e.message); }
  };
  return <div className="sticky-note">
    <NodeResizer isVisible={selected} minWidth={160} minHeight={160} onResizeEnd={(_, p) => api(`/notes/${id}`, 'PATCH', { width: p.width, height: p.height }).catch(e => setError(e.message))} />
    <header>{editingTitle ? <input className="note-title-input nodrag" aria-label="Note title" value={title} maxLength={100} autoFocus onFocus={e => e.target.select()} onChange={e => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { cancelTitle.current = true; e.currentTarget.blur(); } }} /> : <button className="note-title nodrag" title="Edit note title" onClick={() => { setTitle(data.note.title || 'Note'); setEditingTitle(true); }}>{data.note.title || 'Note'}</button>}<button className="icon-btn nodrag" aria-label="Delete note" onClick={() => api(`/notes/${id}`, 'DELETE').catch(e => setError(e.message))}>×</button></header>
    <textarea className="nodrag nowheel" aria-label="Note text" placeholder="Write a note…" maxLength={10000} value={text} onChange={e => { dirty.current = true; setText(e.target.value); }} onBlur={save} />
    {error && <div role="alert">{error}<button className="nodrag" onClick={save}>Retry save</button></div>}
  </div>;
}
const nodeTypes = { agent: AgentNode, note: StickyNote };

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
  const [form, setForm] = useState({ name: '', workdir: '', mode: 'new' });
  const [open, setOpen] = useState(false);
  const [savedWorkdirs, setSavedWorkdirs] = useState([]);
  const [workdirsLoading, setWorkdirsLoading] = useState(false);
  const [workdirsError, setWorkdirsError] = useState('');
  const [docsOpen, setDocsOpen] = useState(false);
  const [guide, setGuide] = useState('');
  const [docsError, setDocsError] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [pointerMode, setPointerMode] = useState('mouse');
  const { screenToFlowPosition } = useReactFlow();

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
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (e) => setState(JSON.parse(e.data));
    return () => stream.close();
  }, []);
  useEffect(() => {
    setNodes(previous => {
      const byId = new Map(previous.map(n => [n.id, n]));
      return [...state.agents.map(agent => {
        const old = byId.get(agent.id);
        return {
          id: agent.id, type: 'agent', position: old?.dragging ? old.position : { x: agent.x, y: agent.y },
          style: { width: agent.width, height: agent.height }, data: { agent }, selected: old?.selected,
        };
      }), ...(state.notes || []).map(note => {
        const old = byId.get(note.id);
        return { id: note.id, type: 'note', position: old?.dragging ? old.position : { x: note.x, y: note.y }, style: { width: note.width, height: note.height }, data: { note }, selected: old?.selected };
      })];
    });
  }, [state.agents, state.notes]);
  const onNodesChange = useCallback(changes => setNodes(ns => applyNodeChanges(changes, ns)), []);
  const onNodeDragStop = useCallback((_, node) => { api(`/${node.type === 'note' ? 'notes' : 'agents'}/${node.id}`, 'PATCH', { x: node.position.x, y: node.position.y }).catch(console.error); }, []);
  const onConnect = useCallback(async ({ source, target }) => { try { await api('/edges', 'POST', { source, target }); } catch (e) { setError(e.message); } }, []);
  const edges = useMemo(() => state.edges.map(edge => ({ ...edge, data: { label: edge.label || 'delegates', onError: setError }, markerEnd: { type: 'arrowclosed', color: '#8aa3e8' } })), [state.edges]);
  const resetCanvas = async () => {
    if (!confirm('Reset Canvas? This stops all agents and removes every node, note, and connection. Pi sessions and project files are NOT deleted. Running work will be interrupted.')) return;
    try { await api('/canvas/reset', 'POST', { confirm: true }); setError(''); }
    catch (e) { setError(e.message); }
  };
  const openLaunch = () => { setError(''); setOpen(true); };
  const createNote = async () => {
    const position = screenToFlowPosition({ x: innerWidth / 2 - 140, y: innerHeight / 2 - 110 });
    try { await api('/notes', 'POST', position); } catch (e) { setError(e.message); }
  };
  const create = async (e) => {
    e.preventDefault(); setError('');
    try {
      const position = screenToFlowPosition({ x: innerWidth / 2 - 210, y: innerHeight / 2 - 160 });
      await api('/agents', 'POST', { ...form, x: position.x, y: position.y });
      setForm(f => ({ ...f, name: '' })); setOpen(false);
    } catch (err) { setError(err.message); }
  };
  return <div className="app">
    <div className="topbar"><div className="brand"><span className="brand-icon">✳</span> Agent Canvas <small>PI WORKSPACE</small></div><div className="top-actions"><span className={`connection ${connected ? '' : 'offline'}`}>{connected ? '● Connected' : '○ Reconnecting'}</span><button className="guide-button" onClick={resetCanvas}>Reset Canvas</button><button className="guide-button" onClick={() => setDocsOpen(true)}>API Guide</button><button className="guide-button" onClick={createNote}>＋ Note</button><button className="primary" onClick={openLaunch}>＋ New agent</button></div></div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onConnect={onConnect} onEdgeClick={async (_, edge) => { if (confirm('Remove this delegation relationship?')) await api(`/edges/${edge.id}`, 'DELETE').catch(e => setError(e.message)); }} panOnDrag={pointerMode === 'mouse' ? [2] : true} panOnScroll={pointerMode === 'touchpad'} zoomOnScroll={pointerMode === 'mouse'} zoomOnPinch zoomOnDoubleClick={false} onPaneContextMenu={e => e.preventDefault()} fitView fitViewOptions={{ padding: 0.3 }} minZoom={0.2} maxZoom={2} connectionLineStyle={{ stroke: '#8aa3e8', strokeWidth: 2 }}>
      <Background color="#243148" gap={24} size={1} /><Controls /><MiniMap pannable zoomable nodeColor={n => n.type === 'note' ? '#f4d77b' : n.data.agent.status === 'running' ? '#9dd9ad' : '#526582'} />
    </ReactFlow>
    {state.agents.length === 0 && !(state.notes || []).length && <div className="empty"><div className="empty-icon">✳</div><h1>Space for your agents.</h1><p>Start a Pi agent, then connect agents to map real delegation.</p><button type="button" className="primary" onClick={openLaunch}>＋ Create your first agent</button><span>{pointerMode === 'mouse' ? 'Right-drag canvas to pan · Wheel to zoom' : 'Drag or two-finger scroll to pan · Pinch to zoom'}</span></div>}
    <div className="hint">Drag nodes · Resize selected nodes · Connect handles to delegate · Click label to edit · Click edge to remove</div>
    <div className="pointer-mode" role="group" aria-label="Canvas pointer mode">
      <button type="button" className={pointerMode === 'mouse' ? 'active' : ''} aria-pressed={pointerMode === 'mouse'} onClick={() => setPointerMode('mouse')} title="Right-drag to pan · Wheel to zoom">Mouse</button>
      <button type="button" className={pointerMode === 'touchpad' ? 'active' : ''} aria-pressed={pointerMode === 'touchpad'} onClick={() => setPointerMode('touchpad')} title="Two-finger scroll to pan · Pinch to zoom">Touchpad</button>
    </div>
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
