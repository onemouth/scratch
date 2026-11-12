import { WebSocketServer, WebSocket } from 'ws';

// Mobile observers share output but never own PTY sizing. Control frames are
// binary JSON; output remains text, preserving the desktop wire protocol.
export function attachTerminalTransport({ server, agents, processes, terminals, allowedOrigin, getGeneration }) {
  const sizes = new WeakMap();
  const size = child => sizes.get(child) || { cols: child?.cols || 50, rows: child?.rows || 16 };
  const sendSize = (ws, child) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'size', ...size(child) }), { binary: true });
  };
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const match = url.pathname.match(/^\/api\/terminal\/([^/]+)$/);
    const mobile = url.searchParams.get('mobile') === '1';
    const id = match?.[1], child = processes.get(id);
    const generation = agents.has(id) ? getGeneration?.(id) : null;
    if (!match || !allowedOrigin(req.headers.origin) || !agents.has(id) ||
        (mobile && (!child || !generation || url.searchParams.get('generation') !== generation))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.canvasMobile = mobile;
      let inputEnabled = !mobile;
      if (!terminals.has(id)) terminals.set(id, new Set());
      const group = terminals.get(id);
      if (mobile) sendSize(ws, child);
      // Replay before subscribing, avoiding duplicate output chunks.
      if (agents.get(id).output) ws.send(agents.get(id).output);
      group.add(ws);
      ws.on('message', bytes => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { return; }
        const current = processes.get(id);
        if (!current || (mobile && (current !== child || getGeneration(id) !== generation))) return;
        if (mobile && message.type === 'input-mode') { inputEnabled = message.enabled === true; return; }
        if (inputEnabled && message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) current.write(message.data);
        if (!mobile && message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
          try {
            current.resize(message.cols, message.rows);
            sizes.set(current, { cols: message.cols, rows: message.rows });
            for (const peer of group) if (peer.canvasMobile) sendSize(peer, current);
          } catch { /* process already exited */ }
        }
      });
      ws.on('close', () => { group.delete(ws); if (!group.size && terminals.get(id) === group) terminals.delete(id); });
    });
  });
  return wss;
}
