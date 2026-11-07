import { WebSocketServer } from 'ws';

// Browser terminal transport only; does not own Agent lifecycle or metadata.
export function attachTerminalTransport({ server, agents, processes, terminals, allowedOrigin }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/api\/terminal\/([^/?]+)$/);
    if (!match || !allowedOrigin(req.headers.origin) || !agents.has(match[1])) { socket.destroy(); return; }
    const id = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!terminals.has(id)) terminals.set(id, new Set());
      const group = terminals.get(id);
      // Replay before subscribing to live output, avoiding duplicate chunks.
      if (agents.get(id).output) ws.send(agents.get(id).output);
      group.add(ws);
      ws.on('message', (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { return; }
        const child = processes.get(id);
        if (!child) return;
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) child.write(message.data);
        if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
          try { child.resize(message.cols, message.rows); } catch { /* process already exited */ }
        }
      });
      ws.on('close', () => { group.delete(ws); if (!group.size) terminals.delete(id); });
    });
  });
  return wss;
}
