import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { pasteChunks } from './terminal-paste.js';

// An observer never fits/resizes the PTY. Binary frames carry authoritative
// dimensions; text frames remain the same ANSI output used by desktop xterm.
export function MobileTerminal({ id, generation, connected }) {
  const host = useRef(null), control = useRef(null);
  const [ready, setReady] = useState(false), [writing, setWriting] = useState(false);
  const [latest, setLatest] = useState(true);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const element = host.current;
    const terminal = new Terminal({ cols: 50, rows: 16, disableStdin: true, cursorBlink: false, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.25, scrollback: 3000, theme: { background: '#101927', foreground: '#d1dcec' } });
    terminal.open(element);
    terminal.textarea.readOnly = true;
    terminal.textarea.tabIndex = -1;
    terminal.textarea.setAttribute('inputmode', 'none');
    let socket, retry, alive = true, enabled = false, available = false, initialSize = true;
    const viewport = element.parentElement;
    const updateLatest = () => setLatest(terminal.buffer.active.viewportY >= terminal.buffer.active.baseY && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2);
    const bottom = () => { terminal.scrollToBottom(); viewport.scrollTop = viewport.scrollHeight; updateLatest(); };
    const width = () => {
      const screen = terminal.element.querySelector('.xterm-screen');
      element.style.width = `${Math.ceil(parseFloat(screen.style.width) || terminal.cols * 9)}px`;
      element.style.minHeight = `${Math.ceil(parseFloat(screen.style.height) || terminal.rows * 18)}px`;
    };
    const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const mode = value => {
      enabled = value && available;
      terminal.options.disableStdin = !enabled;
      terminal.options.cursorBlink = enabled;
      terminal.textarea.readOnly = !enabled;
      terminal.textarea.tabIndex = enabled ? 0 : -1;
      terminal.textarea.setAttribute('inputmode', enabled ? 'text' : 'none');
      send({ type: 'input-mode', enabled });
      setWriting(enabled);
      if (enabled) { bottom(); terminal.focus(); } else terminal.blur();
    };
    control.current = { mode, key: data => { if (enabled && available) { send({ type: 'input', data }); terminal.focus(); } }, bottom };
    const input = terminal.onData(data => { if (enabled && available) send({ type: 'input', data }); });
    const scroll = terminal.onScroll(updateLatest);
    viewport.addEventListener('scroll', updateLatest, { passive: true });
    const paste = event => {
      if (!event.clipboardData) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (enabled && available) for (const data of pasteChunks(event.clipboardData.getData('text/plain'))) send({ type: 'input', data });
    };
    // xterm 6's virtual scrollbar is not a native touch scroll container.
    // Vertical swipes use its public scroll API; horizontal pan/pinch and
    // stationary long-press selection remain browser gestures.
    let touch = null;
    const touchStart = event => {
      touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, active: false, remainder: 0 } : null;
    };
    const touchMove = event => {
      if (!touch || event.touches.length !== 1) { touch = null; return; }
      const point = event.touches[0], dx = point.clientX - touch.x, dy = touch.y - point.clientY;
      if (!touch.active && (Math.abs(dy) < 6 || Math.abs(dy) <= Math.abs(dx))) return;
      touch.active = true; event.preventDefault();
      const prior = viewport.scrollTop;
      viewport.scrollTop += dy;
      const remaining = dy - (viewport.scrollTop - prior) + touch.remainder;
      const cellHeight = parseFloat(terminal.element.querySelector('.xterm-screen').style.height) / terminal.rows || 18;
      const lines = Math.trunc(remaining / cellHeight);
      if (lines) terminal.scrollLines(lines);
      touch.remainder = remaining - lines * cellHeight;
      touch.x = point.clientX; touch.y = point.clientY; updateLatest();
    };
    const touchEnd = () => { touch = null; };
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: false });
    element.addEventListener('touchend', touchEnd);
    element.addEventListener('touchcancel', touchEnd);
    element.addEventListener('paste', paste, true);
    const connect = () => {
      if (!alive) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/${encodeURIComponent(id)}?mobile=1&generation=${encodeURIComponent(generation)}`);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (!alive) return;
        terminal.reset(); initialSize = true; available = true; setReady(true); setEnded(false); mode(false);
      };
      socket.onmessage = event => {
        if (!alive) return;
        if (typeof event.data === 'string') terminal.write(event.data, () => { if (alive) { width(); updateLatest(); } });
        else {
          try {
            const frame = JSON.parse(new TextDecoder().decode(event.data));
            if (frame.type === 'size' && Number.isInteger(frame.cols) && frame.cols >= 2 && frame.cols <= 500 && Number.isInteger(frame.rows) && frame.rows >= 2 && frame.rows <= 200) {
              terminal.resize(frame.cols, frame.rows); width();
              if (initialSize) { viewport.scrollTop = viewport.scrollHeight; initialSize = false; }
              updateLatest();
            }
          } catch { /* Ignore malformed control frames, never render them as ANSI. */ }
        }
      };
      socket.onclose = event => {
        if (!alive) return;
        available = false; mode(false); setReady(false);
        if (event.code === 4001) setEnded(true);
        else retry = setTimeout(connect, 1500);
      };
    };
    width(); connect();
    return () => { alive = false; available = false; enabled = false; clearTimeout(retry); socket?.close(); control.current = null; element.removeEventListener('paste', paste, true); viewport.removeEventListener('scroll', updateLatest); element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove); element.removeEventListener('touchend', touchEnd); element.removeEventListener('touchcancel', touchEnd); input.dispose(); scroll.dispose(); terminal.dispose(); };
  }, [id, generation]);
  useEffect(() => { if (!connected) control.current?.mode(false); }, [connected]);
  return <section className="mobile-terminal" aria-label="Agent terminal">
    <div className="mobile-terminal-tools">
      <span role="status">{ended ? 'Process ended' : !ready || !connected ? 'Disconnected · input disabled' : writing ? 'Input enabled' : 'Monitoring'}</span>
      <button type="button" disabled={!ready || !connected} aria-pressed={writing} onClick={() => control.current?.mode(!writing)}>{writing ? 'Monitor' : 'Input'}</button>
      {!latest && <button type="button" onClick={() => control.current?.bottom()}>Latest ↓</button>}
    </div>
    {writing && <div className="mobile-terminal-keys" aria-label="Terminal keys">{[['Esc', '\u001b'], ['Tab', '\t'], ['Ctrl+C', '\u0003'], ['Enter', '\r']].map(([label, data]) => <button type="button" key={label} onPointerDown={event => event.preventDefault()} onClick={() => control.current?.key(data)}>{label}</button>)}</div>}
    <div className="mobile-terminal-scroll"><div ref={host} className="mobile-terminal-canvas" /></div>
  </section>;
}
