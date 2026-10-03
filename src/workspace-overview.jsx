import React, { useEffect, useRef } from 'react';
import { Panel, useReactFlow, useStore, useViewport } from '@xyflow/react';
import { workspaceOverview } from './workspace-overview.js';

export function WorkspaceOverview({ nodes, workspace }) {
  const width = useStore(state => state.width), height = useStore(state => state.height);
  const viewport = useViewport();
  const { setViewport } = useReactFlow();
  const { rectangles, view, bounds } = workspaceOverview(nodes, workspace, viewport, width, height);
  const svg = useRef(null), drag = useRef(null), wheel = useRef(null);
  const color = node => node.type === 'note' ? '#f4d77b' : node.type === 'card' ? '#e5e8fa' : node.data.agent.status === 'running' ? '#9dd9ad' : '#526582';
  wheel.current = event => {
    event.preventDefault(); event.stopPropagation();
    const zoom = Math.max(0.18, Math.min(1.5, viewport.zoom * Math.exp(-event.deltaY * 0.002)));
    const cx = (width / 2 - viewport.x) / viewport.zoom, cy = (height / 2 - viewport.y) / viewport.zoom;
    setViewport({ x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom });
  };
  useEffect(() => {
    const element = svg.current, onWheel = event => wheel.current(event);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  const start = event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = bounds.x + (event.clientX - rect.left) / rect.width * bounds.width;
    const y = bounds.y + (event.clientY - rect.top) / rect.height * bounds.height;
    const next = { x: width / 2 - x * viewport.zoom, y: height / 2 - y * viewport.zoom, zoom: viewport.zoom };
    drag.current = { x: event.clientX, y: event.clientY, scale: bounds.width / rect.width, viewport: next };
    event.currentTarget.setPointerCapture(event.pointerId);
    setViewport(next);
  };
  const move = event => {
    if (!drag.current) return;
    event.stopPropagation();
    const start = drag.current;
    setViewport({ ...start.viewport, x: start.viewport.x - (event.clientX - start.x) * start.scale * start.viewport.zoom, y: start.viewport.y - (event.clientY - start.y) * start.scale * start.viewport.zoom });
  };
  const end = () => { drag.current = null; };
  return <Panel position="bottom-right" className="react-flow__minimap workspace-overview">
    <svg ref={svg} width="200" height="150" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="img" aria-label={workspace === 'card-box' ? 'Card box overview' : 'Agent Canvas overview'} style={{ display: 'block', touchAction: 'none', cursor: 'grab' }} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {rectangles.map(rect => <rect key={rect.id} data-node-id={rect.id} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={5} fill={color(rect.node)} />)}
      <path d={`M${bounds.x},${bounds.y}h${bounds.width}v${bounds.height}h${-bounds.width}z M${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z`} fill="rgba(8,15,28,0.65)" fillRule="evenodd" pointerEvents="none" />
    </svg>
  </Panel>;
}
