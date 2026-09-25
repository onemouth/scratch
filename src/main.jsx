import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, Handle, MiniMap, NodeResizer, Position, applyNodeChanges, useReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function AgentNode({ id, data, selected }) {
  const agent = data.agent;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const outputRef = React.useRef(null);
  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [agent.output]);
  const act = async (path, body) => {
    setError('');
    try { await api(`/agents/${id}/${path}`, 'POST', body); } catch (e) { setError(e.message); }
  };
  const send = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    await act('prompt', { message });
    setMessage('');
  };
  return <div className={`agent-node ${agent.status}`}>
    <NodeResizer isVisible={selected} minWidth={320} minHeight={240} onResizeEnd={(_, p) => api(`/agents/${id}`, 'PATCH', { width: p.width, height: p.height }).catch(console.error)} />
    <Handle type="target" position={Position.Left} />
    <header className="node-header">
      <span className="status-dot" /><strong title={agent.name}>{agent.name}</strong><span className="badge">{agent.status}</span>
      {agent.status !== 'stopped' && <button className="icon-btn nodrag" title="Stop agent" onClick={() => act('stop')}>■</button>}
    </header>
    <div className="node-subtitle" title={agent.workdir}>{agent.workdir}</div>
    {agent.note && <div className="node-note" title={agent.note}>{agent.note}</div>}
    <pre className="terminal nodrag nowheel" ref={outputRef}>{agent.output || 'Starting Pi…'}</pre>
    {error && <div className="node-error">{error}</div>}
    <form className="prompt nodrag" onSubmit={send}>
      <textarea className="nowheel" rows="2" placeholder={agent.status === 'stopped' ? 'Agent stopped' : 'Message agent… (Enter to send)'} value={message} disabled={agent.status === 'stopped'} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} />
      <div className="prompt-actions">
        {agent.status === 'working' && <button type="button" onClick={() => act('abort')}>Abort</button>}
        <button type="submit" disabled={agent.status === 'stopped' || !message.trim()}>Send ↵</button>
      </div>
    </form>
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
      <Background color="#243148" gap={24} size={1} /><Controls /><MiniMap pannable zoomable nodeColor={n => n.data.agent.status === 'working' ? '#9dd9ad' : '#526582'} />
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
