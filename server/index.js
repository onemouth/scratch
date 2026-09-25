import http from 'node:http';
import pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const apiGuide = join(root, 'docs', 'agent-api.md');
const MAX_OUTPUT = 80000;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function createApp({ port = Number(process.env.PORT || 3001), spawnAgent = pty.spawn } = {}) {
  const agents = new Map();
  const processes = new Map();
  const edges = new Map();
  const clients = new Set();
  const terminals = new Map();
  const wss = new WebSocketServer({ noServer: true });
  let pending = false;
  const snapshot = () => ({ agents: [...agents.values()], edges: [...edges.values()] });
  const broadcast = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const client of clients) client.write(data);
    }, 50);
  };
  const output = (agent, text) => {
    agent.output = (agent.output + text).slice(-MAX_OUTPUT);
    for (const socket of terminals.get(agent.id) || []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  };
  const validText = (x, max = 10000) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
  const requireAgent = (id) => {
    const agent = agents.get(id);
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
    return agent;
  };
  const connect = (source, target) => {
    requireAgent(source); requireAgent(target);
    if (source === target) throw new Error('Cannot delegate to self');
    const existing = [...edges.values()].find((edge) => edge.source === source && edge.target === target);
    if (existing) return existing;
    const edge = { id: randomUUID(), source, target, type: 'delegates' };
    edges.set(edge.id, edge);
    broadcast();
    return edge;
  };
  const createAgent = (body) => {
    if (!validText(body.name, 100) || !validText(body.workdir, 2048) || !validText(body.task)) throw new Error('name, workdir, and task are required');
    const workdir = resolve(body.workdir);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error('workdir must be an existing directory');
    if (body.parentId) requireAgent(body.parentId);
    const id = randomUUID();
    const index = agents.size;
    const agent = {
      id, name: body.name.trim(), workdir, task: body.task.trim(), status: 'running', output: '',
      note: '', x: Number.isFinite(body.x) ? body.x : 100 + (index % 3) * 490,
      y: Number.isFinite(body.y) ? body.y : 100 + Math.floor(index / 3) * 380,
      width: 440, height: 320,
    };
    const base = `http://127.0.0.1:${port}`;
    const instructions = `You are an agent on Agent Canvas. Your agent ID is ${id}. The canvas API is at ${base}/api. Use your bash tool with curl to interact with it. GET /api/state reads all agents and delegation relationships. POST /api/agents with JSON {"name":"...","workdir":"absolute path","task":"...","parentId":"${id}"} creates a child agent and a delegation edge. POST /api/edges with {"source":"${id}","target":"agent-id"} records delegation without sending messages. PATCH /api/agents/${id} with {"note":"short progress summary"} updates your note. Relationships represent real delegation; only create them when delegating actual work. Never modify canvas coordinates. This API is local to this server. Read the full guide with curl -fsS ${base}/api/docs when you need examples or details.`;
    let child;
    try {
      child = spawnAgent('pi', ['--no-session', '--name', agent.name, '--append-system-prompt', instructions, '--', agent.task], {
        cwd: workdir, cols: 50, rows: 16, name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'none', AGENT_CANVAS_URL: base, AGENT_CANVAS_ID: id },
      });
    } catch (error) { throw Object.assign(new Error(`Could not start pi: ${error.message}`), { status: 500 }); }
    agents.set(id, agent);
    processes.set(id, child);
    if (body.parentId) connect(body.parentId, id);
    child.onData((data) => output(agent, data));
    child.onExit(({ exitCode, signal }) => {
      processes.delete(id);
      agent.status = 'stopped';
      output(agent, `\r\n[Pi exited: ${signal ? `signal ${signal}` : `code ${exitCode}`}]\r\n`);
      broadcast();
    });
    broadcast();
    return agent;
  };

  const reply = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const allowedOrigin = (origin) => !origin || [`http://127.0.0.1:${port}`, 'http://127.0.0.1:5173'].includes(origin);
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!allowedOrigin(req.headers.origin)) return reply(res, 403, { error: 'Cross-origin requests are not allowed' });
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot());
    if (url.pathname === '/api/docs' && req.method === 'GET') {
      const backendUrl = `http://127.0.0.1:${server.address().port}`;
      // The web UI passes its own origin, since Vite may rewrite Host when proxying.
      const requestedOrigin = url.searchParams.get('origin');
      const canvasUrl = requestedOrigin === 'http://127.0.0.1:5173' ? requestedOrigin : backendUrl;
      const guide = readFileSync(apiGuide, 'utf8').replaceAll('$AGENT_CANVAS_URL', canvasUrl);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(guide);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        let body = {};
        if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 100000) throw Object.assign(new Error('Request too large'), { status: 413 });
          }
          if (raw) body = JSON.parse(raw);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object');
        }
        if (url.pathname === '/api/agents' && req.method === 'POST') return reply(res, 201, createAgent(body));
        if (url.pathname === '/api/edges' && req.method === 'POST') return reply(res, 201, connect(body.source, body.target));
        const edgeMatch = url.pathname.match(/^\/api\/edges\/([^/]+)$/);
        if (edgeMatch && req.method === 'DELETE') {
          if (!edges.delete(edgeMatch[1])) return reply(res, 404, { error: 'Edge not found' });
          broadcast(); return reply(res, 200, { ok: true });
        }
        const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(stop))?$/);
        if (match) {
          const agent = requireAgent(match[1]);
          if (match[2] === 'stop' && req.method === 'POST') {
            processes.get(agent.id)?.kill();
            agent.status = 'stopped'; broadcast();
            return reply(res, 200, { ok: true });
          }
          if (!match[2] && req.method === 'PATCH') {
            if (body.note !== undefined) {
              if (typeof body.note !== 'string' || body.note.length > 500) throw new Error('note must be at most 500 characters');
              agent.note = body.note;
            }
            for (const key of ['x', 'y', 'width', 'height']) {
              if (body[key] !== undefined) {
                if (!Number.isFinite(body[key]) || (['width', 'height'].includes(key) && body[key] < 240)) throw new Error(`Invalid ${key}`);
                agent[key] = body[key];
              }
            }
            broadcast(); return reply(res, 200, agent);
          }
        }
        return reply(res, 404, { error: 'Not found' });
      } catch (error) {
        return reply(res, error.status || 400, { error: error.message });
      }
    }
    if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
    const file = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) return reply(res, 404, { error: 'Run npm run build or npm run dev' });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };
  const server = http.createServer((req, res) => { handler(req, res).catch((error) => reply(res, 500, { error: error.message })); });
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
  return {
    server, snapshot,
    listen: () => new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)),
    close: () => new Promise((resolveClose) => {
      for (const client of clients) client.end();
      for (const group of terminals.values()) for (const ws of group) ws.terminate();
      wss.close();
      for (const child of processes.values()) child.kill();
      server.close(resolveClose);
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen().then(() => console.log(`Agent Canvas API: http://127.0.0.1:${process.env.PORT || 3001}`));
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
