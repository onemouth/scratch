import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, Handle, MiniMap, NodeResizer, Position, applyNodeChanges, useReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

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
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/${id}`);
      socket.onopen = () => { terminal.reset(); resize(); };
      socket.onmessage = event => terminal.write(event.data);
      socket.onclose = () => { if (alive) retry = setTimeout(connect, 1500); };
    };
    connect();
    return () => { alive = false; clearTimeout(retry); socket?.close(); observer.disconnect(); input.dispose(); terminal.dispose(); termRef.current = null; };
  }, [id]);
  useEffect(() => { if (stopped) termRef.current?.blur(); }, [stopped]);
  return <div className="terminal nodrag nowheel" ref={container} onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} />;
}

function AgentNode({ id, data, selected }) {
  const agent = data.agent;
  const [error, setError] = useState('');
  const stop = async () => { try { await api(`/agents/${id}/stop`, 'POST'); } catch (e) { setError(e.message); } };
  return <div className={`agent-node ${agent.status}`}>
    <NodeResizer isVisible={selected} minWidth={320} minHeight={240} onResizeEnd={(_, p) => api(`/agents/${id}`, 'PATCH', { width: p.width, height: p.height }).catch(console.error)} />
    <Handle type="target" position={Position.Left} />
    <header className="node-header">
      <span className="status-dot" /><strong title={agent.name}>{agent.name}</strong><span className="badge">{agent.status}</span>
      {agent.status !== 'stopped' && <button className="icon-btn nodrag" title="Stop agent" onClick={stop}>■</button>}
    </header>
    <div className="node-subtitle" title={agent.workdir}>{agent.workdir}</div>
    {agent.note && <div className="node-note" title={agent.note}>{agent.note}</div>}
    <PtyTerminal id={id} stopped={agent.status === 'stopped'} />
    {error && <div className="node-error">{error}</div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { agent: AgentNode };

function Canvas() {
  const [state, setState] = useState({ agents: [], edges: [] });
  const [nodes, setNodes] = useState([]);
  const [form, setForm] = useState({ name: '', workdir: '', task: '' });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

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
      return state.agents.map(agent => {
        const old = byId.get(agent.id);
        return {
          id: agent.id, type: 'agent', position: old?.dragging ? old.position : { x: agent.x, y: agent.y },
          style: { width: agent.width, height: agent.height }, data: { agent }, selected: old?.selected,
        };
      });
    });
  }, [state.agents]);
  const onNodesChange = useCallback(changes => setNodes(ns => applyNodeChanges(changes, ns)), []);
  const onNodeDragStop = useCallback((_, node) => { api(`/agents/${node.id}`, 'PATCH', { x: node.position.x, y: node.position.y }).catch(console.error); }, []);
  const onConnect = useCallback(async ({ source, target }) => { try { await api('/edges', 'POST', { source, target }); } catch (e) { setError(e.message); } }, []);
  const edges = useMemo(() => state.edges.map(edge => ({ ...edge, animated: false, label: 'delegates', style: { stroke: '#8aa3e8', strokeWidth: 2 }, labelStyle: { fill: '#9facce', fontSize: 11 }, markerEnd: { type: 'arrowclosed', color: '#8aa3e8' } })), [state.edges]);
  const create = async (e) => {
    e.preventDefault(); setError('');
    try {
      const position = screenToFlowPosition({ x: innerWidth / 2 - 210, y: innerHeight / 2 - 160 });
      await api('/agents', 'POST', { ...form, x: position.x, y: position.y });
      setForm(f => ({ ...f, name: '', task: '' })); setOpen(false);
    } catch (err) { setError(err.message); }
  };
  return <div className="app">
    <div className="topbar"><div className="brand"><span className="brand-icon">✳</span> Agent Canvas <small>PI WORKSPACE</small></div><div className="top-actions"><span className={`connection ${connected ? '' : 'offline'}`}>{connected ? '● Connected' : '○ Reconnecting'}</span><button className="primary" onClick={() => { setError(''); setOpen(true); }}>＋ New agent</button></div></div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onConnect={onConnect} onEdgeClick={async (_, edge) => { if (confirm('Remove this delegation relationship?')) await api(`/edges/${edge.id}`, 'DELETE').catch(e => setError(e.message)); }} fitView fitViewOptions={{ padding: 0.3 }} minZoom={0.2} maxZoom={2} connectionLineStyle={{ stroke: '#8aa3e8', strokeWidth: 2 }}>
      <Background color="#243148" gap={24} size={1} /><Controls /><MiniMap pannable zoomable nodeColor={n => n.data.agent.status === 'running' ? '#9dd9ad' : '#526582'} />
      {state.agents.length === 0 && <div className="empty"><div className="empty-icon">✳</div><h1>Space for your agents.</h1><p>Start a Pi agent, then connect agents to map real delegation.</p><button className="primary" onClick={() => setOpen(true)}>＋ Create your first agent</button><span>Drag canvas to pan · Scroll to zoom</span></div>}
    </ReactFlow>
    <div className="hint">Drag nodes · Resize selected nodes · Connect handles to delegate · Click edge to remove</div>
    {error && !open && <div className="toast" onClick={() => setError('')}>{error} ×</div>}
    {open && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}><form className="modal" onSubmit={create}>
      <div className="modal-head"><div><small>NEW SESSION</small><h2>Launch a Pi agent</h2></div><button type="button" className="icon-btn" onClick={() => setOpen(false)}>×</button></div>
      <label>Name<input autoFocus required maxLength="100" placeholder="e.g. Researcher" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label>Working directory<input required placeholder="/absolute/path/to/project" value={form.workdir} onChange={e => setForm({ ...form, workdir: e.target.value })} /></label>
      <label>First task<textarea required rows="5" placeholder="What should this agent work on?" value={form.task} onChange={e => setForm({ ...form, task: e.target.value })} /></label>
      {error && <div className="node-error">{error}</div>}
      <div className="modal-actions"><button type="button" onClick={() => setOpen(false)}>Cancel</button><button className="primary" type="submit">Launch agent →</button></div>
    </form></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
