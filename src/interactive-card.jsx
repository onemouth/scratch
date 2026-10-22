import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildInteractiveDocument, usesInteractiveRuntime } from './interactive-card.js';
import { forwardInteractiveWheel } from './interactive-scroll.js';

const identifier = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

export function InteractiveContent({ card }) {
  const host = useRef(null);
  const frame = useRef(null);
  const [visible, setVisible] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState({ state: 'loading', card: null, error: '' });
  const [assets, setAssets] = useState({ state: 'loading', urls: {}, error: '' });
  const runtimeCard = source.card;
  const dynamic = runtimeCard ? usesInteractiveRuntime(runtimeCard) : false;
  const identity = `${card.id}:${card.interactive.revision}`;
  const nonce = useMemo(identifier, [identity, running]);
  const token = useMemo(identifier, [identity, running]);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setRunning(false); setError(''); }, [identity]);
  useEffect(() => { if (!visible) { setRunning(false); setError(''); } }, [visible]);
  useEffect(() => {
    if (!visible) { setSource({ state: 'loading', card: null, error: '' }); return; }
    const controller = new AbortController();
    fetch(`/api/cards/${encodeURIComponent(card.id)}`, { signal: controller.signal }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      if (value.type !== 'interactive' || value.interactive.revision !== card.interactive.revision) throw new Error('Interactive source changed; waiting for refresh');
      const jsxgraph = value.interactive.javascript.trim() ? (await import('./jsxgraph-bundle.js')).jsxgraph : null;
      if (!controller.signal.aborted) setSource({ state: 'ready', card: value, jsxgraph, identity, error: '' });
    }).catch(reason => { if (!controller.signal.aborted) setSource({ state: 'error', card: null, error: reason.message }); });
    return () => controller.abort();
  }, [identity, visible]);
  useEffect(() => {
    if (!visible) { setAssets({ state: 'loading', urls: {}, error: '' }); return; }
    const urls = Object.fromEntries((card.assets || []).map(asset => [asset.name, new URL(asset.url, location.href).href]));
    setAssets({ state: 'ready', urls, error: '' });
  }, [identity, visible, (card.assets || []).map(asset => `${asset.id}:${asset.url}`).join('|')]);
  useEffect(() => {
    const element = host.current;
    const wheel = event => forwardInteractiveWheel(event, frame.current, token);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [token]);
  useEffect(() => {
    const receive = event => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'agent-canvas-interactive-error' || event.data.token !== token) return;
      setError(event.data.message || 'Interactive content failed'); setRunning(false);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token]);

  const sourceReady = source.state === 'ready' && source.identity === identity;
  const document = sourceReady && assets.state === 'ready' && visible
    ? buildInteractiveDocument(runtimeCard, assets.urls, { run: !dynamic || running, nonce, token, jsxgraph: source.jsxgraph }) : '';
  return <div className="interactive-content" ref={host}>
    {!visible ? <div className="interactive-placeholder">Interactive content paused</div>
      : source.state === 'error' ? <div className="interactive-error" role="alert">Interactive content failed<br /><span>{source.error}</span></div>
      : assets.state === 'error' ? <div className="interactive-error" role="alert">Interactive content failed<br /><span>{assets.error}</span></div>
      : !sourceReady || assets.state !== 'ready' ? <div className="interactive-placeholder">Loading interactive content…</div>
      : <iframe ref={frame} key={`${identity}:${running}`} title={card.title} sandbox="allow-scripts" allow="autoplay; camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcDoc={document} onLoad={event => {
          if (event.currentTarget.dataset.loaded) { setError('Navigation outside this card was blocked'); setRunning(false); return; }
          event.currentTarget.dataset.loaded = 'true';
        }} />}
    {visible && sourceReady && assets.state === 'ready' && dynamic && !running && !error && <button type="button" className="interactive-play" onClick={() => setRunning(true)}>Play</button>}
    {visible && error && <div className="interactive-error" role="alert">Interactive content failed<br /><span>{error}</span><button type="button" onClick={() => { setError(''); setRunning(true); }}>Restart</button></div>}
    {visible && running && !error && <button type="button" className="interactive-restart" onClick={() => { setRunning(false); queueMicrotask(() => setRunning(true)); }}>Restart</button>}
  </div>;
}
