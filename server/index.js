import http from 'node:http';
import { lockCanvas, loadCanvas, saveCanvas } from './canvas-store.js';
import pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { readdir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const apiGuide = join(root, 'docs', 'agent-api.md');
const MAX_OUTPUT = 80000;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function savedWorkdirs(sessionRoot) {
  let projects;
  try { projects = await readdir(sessionRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const directories = [sessionRoot, ...projects.filter(entry => entry.isDirectory()).map(entry => join(sessionRoot, entry.name))];
  const workdirs = new Map();
  for (const directory of directories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(directory, entry.name);
      try {
        const handle = await open(file, 'r');
        let header;
        try {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const end = buffer.indexOf(10);
          if (end < 0 || end >= bytesRead) continue;
          header = JSON.parse(buffer.toString('utf8', 0, end));
        } finally { await handle.close(); }
        if (header.type !== 'session' || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) continue;
        const cwd = resolve(header.cwd);
        if (!(await stat(cwd)).isDirectory()) continue;
        const { mtimeMs } = await stat(file);
        const item = workdirs.get(cwd) ?? { path: cwd, sessionCount: 0, lastUsed: 0 };
        item.sessionCount++;
        item.lastUsed = Math.max(item.lastUsed, mtimeMs);
        workdirs.set(cwd, item);
      } catch { /* ignore malformed or inaccessible session files */ }
    }
  }
  return [...workdirs.values()].sort((a, b) => b.lastUsed - a.lastUsed || a.path.localeCompare(b.path));
}

export function createApp({ port = Number(process.env.PORT || 3001), spawnAgent = pty.spawn, stateFile = null,
  sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions') } = {}) {
  const agents = new Map();
  const processes = new Map();
  const edges = new Map();
  const notes = new Map();
  const clients = new Set();
  const terminals = new Map();
  const wss = new WebSocketServer({ noServer: true });
  let pending = false;
  let closing = false;
  let started = false;
  let resetting = false;
  let closePromise;
  let unlock = () => {};
  let saveTimer;
  let saveError = '';
  const runs = new Map();
  const snapshot = () => ({ agents: [...agents.values()], edges: [...edges.values()], notes: [...notes.values()], persistence: { enabled: !!stateFile, error: saveError } });
  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!started) return;
    try { saveCanvas(stateFile, snapshot()); saveError = ''; }
    catch (error) { saveError = error.message; console.error('Canvas save failed:', error.message); }
  };
  const broadcast = () => {
    if (closing || resetting) return;
    if (stateFile) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { flush(); publish(); }, 250); }
    publish();
  };
  const publish = () => {
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
  const sendMessage = (body) => {
    if ((body.toId === undefined) === (body.toName === undefined)) throw new Error('Specify exactly one of toId or toName');
    let target;
    if (body.toId !== undefined) {
      if (!validText(body.toId, 100)) throw new Error('toId must be a non-empty agent ID');
      target = requireAgent(body.toId);
    } else {
      if (!validText(body.toName, 100)) throw new Error('toName must be a non-empty agent name');
      const matches = [...agents.values()].filter(agent => agent.name === body.toName);
      if (!matches.length) throw Object.assign(new Error('Agent not found'), { status: 404 });
      if (matches.length > 1) throw Object.assign(new Error('Agent name is ambiguous; use toId'), { status: 409 });
      target = matches[0];
    }
    if (!validText(body.text, 10000) || /[\x00-\x08\x0b-\x1f\x7f]/.test(body.text)) {
      throw new Error('text must be 1–10000 characters without terminal control characters');
    }
    const sender = body.fromId === undefined ? null : requireAgent(body.fromId);
    const child = processes.get(target.id);
    if (target.status !== 'running' || !child) throw Object.assign(new Error('Target agent is not running'), { status: 409 });
    const text = sender ? `Canvas message from agent ${sender.id}:\n${body.text}` : body.text;
    // Bracketed paste keeps embedded newlines from acting as Enter keys; the final CR submits the prompt.
    child.write(`\x1b[200~${text}\x1b[201~\r`);
    return { ok: true, targetId: target.id, status: 'written-to-tty' };
  };
  const edgeLabel = (value) => {
    if (typeof value !== 'string' || !validText(value, 120)) throw new Error('label must be 1–120 characters');
    return value.trim();
  };
  const connect = (source, target, label = 'delegates') => {
    requireAgent(source); requireAgent(target);
    const displayLabel = edgeLabel(label);
    if (source === target) throw new Error('Cannot delegate to self');
    const existing = [...edges.values()].find((edge) => edge.source === source && edge.target === target);
    if (existing) return existing;
    const edge = { id: randomUUID(), source, target, type: 'delegates', label: displayLabel };
    edges.set(edge.id, edge);
    broadcast();
    return edge;
  };
  const createAgent = (body) => {
    const mode = body.mode ?? 'new';
    if (!['new', 'resume'].includes(mode)) throw new Error('mode must be new or resume');
    if (!validText(body.name, 100) || !validText(body.workdir, 2048)) throw new Error('name and workdir are required');
    if (mode === 'new' && body.task !== undefined && !validText(body.task)) throw new Error('task must be non-empty when provided');
    if (mode === 'resume' && body.task !== undefined) throw new Error('task cannot be set when resuming a session');
    const workdir = resolve(body.workdir);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error('workdir must be an existing directory');
    if (body.parentId) requireAgent(body.parentId);
    const id = randomUUID();
    const index = agents.size;
    const agent = {
      id, name: body.name.trim(), workdir, mode, task: mode === 'new' ? (body.task?.trim() ?? '') : '', status: 'running', output: '',
      note: '', x: Number.isFinite(body.x) ? body.x : 100 + (index % 3) * 490,
      y: Number.isFinite(body.y) ? body.y : 100 + Math.floor(index / 3) * 380,
      width: 440, height: 320,
    };
    startAgent(agent);
    if (body.parentId) connect(body.parentId, id);
    return agent;
  };
  const startAgent = (agent, restoring = false, picker = false) => {
    const { id, workdir, mode } = agent;
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error('workdir no longer exists; restore the directory and retry');
    let exactSession = false;
    if (restoring && !picker && agent.sessionFile) {
      try {
        const lines = readFileSync(agent.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        if (lines[0]?.type !== 'session' || lines[0]?.id !== agent.sessionId) throw new Error('Session identity mismatch');
        exactSession = true;
      } catch { /* missing or invalid session: open the picker rather than a new conversation */ }
    }
    agent.restoreWarning = restoring && !exactSession ? 'Original session unavailable. Select a conversation in Pi’s session picker.' : '';
    agent.status = 'running';
    agent.output = '';
    const runToken = randomUUID();
    runs.set(id, { token: runToken, ready: false });
    const base = `http://127.0.0.1:${server.address()?.port || port}`;
    const instructions = `You are an agent on Agent Canvas. Your agent ID is ${id}. The canvas API is at ${base}/api. Use your bash tool with curl to interact with it. GET /api/state reads all agents and delegation relationships. POST /api/agents with JSON {"name":"...","workdir":"absolute path","task":"...","parentId":"${id}"} creates a child agent and a delegation edge. POST /api/edges with {"source":"${id}","target":"agent-id"} records delegation without sending messages. POST /api/messages with {"toId":"agent-id","fromId":"${id}","text":"..."} sends an explicit message to a running agent's Pi TTY; use toName instead of toId only when the name is unique. PATCH /api/agents/${id} with {"note":"short progress summary"} updates your note. Relationships represent real delegation; only create them when delegating actual work. Never modify canvas coordinates. This API is local to this server. Read the full guide with curl -fsS ${base}/api/docs when you need examples or details.`;
    let child;
    try {
      const common = ['--extension', join(root, 'server', 'pi-session-tracker.js'), '--append-system-prompt', instructions];
      const args = restoring
        ? [...(exactSession ? ['--session', agent.sessionFile] : ['--resume']), ...common]
        : mode === 'resume' ? ['--resume', ...common]
          : ['--name', agent.name, ...common, ...(agent.task ? ['--', agent.task] : [])];
      child = spawnAgent('pi', args, {
        cwd: workdir, cols: 50, rows: 16, name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'none', AGENT_CANVAS_URL: base, AGENT_CANVAS_ID: id, AGENT_CANVAS_RUN: runToken },
      });
    } catch (error) {
      runs.delete(id);
      agent.status = 'stopped';
      throw Object.assign(new Error(`Could not start pi: ${error.message}`), { status: 500 });
    }
    agents.set(id, agent);
    processes.set(id, child);
    for (const ws of terminals.get(id) || []) if (ws.readyState === WebSocket.OPEN) ws.send('\x1bc');
    child.onData((data) => output(agent, data));
    child.onExit(({ exitCode, signal }) => {
      if (processes.get(id) !== child) return;
      processes.delete(id);
      const run = runs.get(id);
      runs.delete(id);
      const wasStopping = agent.status === 'stopping';
      agent.status = 'stopped';
      if (!closing && !wasStopping && restoring && exactSession && !run?.ready && exitCode !== 0 && agents.has(id)) {
        try { startAgent(agent, true, true); return; }
        catch (error) { agent.restoreWarning = error.message; }
      }
      output(agent, `\r\n[Pi exited: ${signal ? `signal ${signal}` : `code ${exitCode}`}]\r\n`);
      broadcast();
    });
    broadcast();
    return agent;
  };

  const stopProcesses = async () => {
    await Promise.all([...processes.values()].map(child => new Promise((resolveStop, rejectStop) => {
      let timeout;
      let escalation;
      const cleanup = () => { clearTimeout(timeout); clearTimeout(escalation); };
      child.onExit(() => { cleanup(); resolveStop(); });
      escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exit may already be in flight */ } }, 1500);
      timeout = setTimeout(() => { cleanup(); rejectStop(new Error('A Pi process did not stop; Canvas has not been cleared')); }, 3500);
      try { child.kill(); } catch (error) { cleanup(); rejectStop(error); }
    })));
  };
  const reply = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const allowedOrigin = (origin) => !origin || [`http://127.0.0.1:${server.address()?.port || port}`, 'http://127.0.0.1:5173'].includes(origin);
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
    if (url.pathname === '/api/session-workdirs' && req.method === 'GET') {
      try { return reply(res, 200, { workdirs: await savedWorkdirs(sessionsRoot) }); }
      catch (error) { return reply(res, 500, { error: error.message }); }
    }
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
        if (closing || resetting) return reply(res, 503, { error: 'Canvas is shutting down or resetting' });
        if (url.pathname === '/api/canvas/reset' && req.method === 'POST') {
          if (body.confirm !== true) throw new Error('Reset requires confirm: true');
          resetting = true;
          clearTimeout(saveTimer);
          for (const agent of agents.values()) if (processes.has(agent.id)) agent.status = 'stopping';
          try { await stopProcesses(); }
          catch (error) { resetting = false; broadcast(); throw error; }
          processes.clear(); runs.clear();
          for (const group of terminals.values()) for (const ws of group) ws.terminate();
          terminals.clear(); agents.clear(); notes.clear(); edges.clear();
          resetting = false;
          flush(); publish();
          if (saveError) return reply(res, 500, { error: `Canvas cleared in memory but could not save reset: ${saveError}` });
          return reply(res, 200, { ok: true });
        }
        const sessionMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/session$/);
        if (sessionMatch && req.method === 'POST') {
          const agent = requireAgent(sessionMatch[1]);
          const run = runs.get(agent.id);
          if (!run || body.runToken !== run.token) return reply(res, 409, { error: 'Stale Pi process' });
          if (body.sessionFile !== null && (!validText(body.sessionFile, 4096) || !isAbsolute(body.sessionFile))) throw new Error('Invalid session file');
          if (!validText(body.sessionId, 100)) throw new Error('Invalid session ID');
          agent.sessionFile = body.sessionFile;
          agent.sessionId = body.sessionId;
          run.ready = true;
          agent.restoreWarning = '';
          broadcast(); return reply(res, 200, { ok: true });
        }
        if (url.pathname === '/api/agents' && req.method === 'POST') return reply(res, 201, createAgent(body));
        if (url.pathname === '/api/messages' && req.method === 'POST') return reply(res, 202, sendMessage(body));
        const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
        if ((url.pathname === '/api/notes' && req.method === 'POST') || (noteMatch && ['PATCH', 'DELETE'].includes(req.method))) {
          const existing = noteMatch ? notes.get(noteMatch[1]) : null;
          if (noteMatch && !existing) return reply(res, 404, { error: 'Note not found' });
          if (req.method === 'DELETE') {
            notes.delete(existing.id); broadcast(); return reply(res, 200, { ok: true });
          }
          const updated = { ...(existing || { id: randomUUID(), title: 'Note', text: '', x: 0, y: 0, width: 280, height: 220 }) };
          if (body.title !== undefined) {
            if (!validText(body.title, 100)) throw new Error('title must be 1–100 characters');
            updated.title = body.title.trim();
          }
          if (body.text !== undefined) {
            if (typeof body.text !== 'string' || body.text.length > 10000) throw new Error('text must be at most 10000 characters');
            updated.text = body.text;
          }
          for (const key of ['x', 'y', 'width', 'height']) {
            if (body[key] === undefined) continue;
            if (!Number.isFinite(body[key]) || (['width', 'height'].includes(key) && body[key] < 160)) throw new Error(`Invalid ${key}`);
            updated[key] = body[key];
          }
          notes.set(updated.id, updated); broadcast();
          return reply(res, existing ? 200 : 201, updated);
        }
        if (url.pathname === '/api/edges' && req.method === 'POST') return reply(res, 201, connect(body.source, body.target, body.label));
        const edgeMatch = url.pathname.match(/^\/api\/edges\/([^/]+)$/);
        if (edgeMatch && req.method === 'PATCH') {
          const edge = edges.get(edgeMatch[1]);
          if (!edge) return reply(res, 404, { error: 'Edge not found' });
          edge.label = edgeLabel(body.label);
          broadcast(); return reply(res, 200, edge);
        }
        if (edgeMatch && req.method === 'DELETE') {
          if (!edges.delete(edgeMatch[1])) return reply(res, 404, { error: 'Edge not found' });
          broadcast(); return reply(res, 200, { ok: true });
        }
        const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(stop|resume))?$/);
        if (match) {
          const agent = requireAgent(match[1]);
          if (match[2] === 'resume' && req.method === 'POST') {
            if (processes.has(agent.id)) return reply(res, 409, { error: 'Agent is already running' });
            try { startAgent(agent, true); }
            catch (error) { agent.status = 'stopped'; agent.restoreWarning = error.message; broadcast(); throw error; }
            return reply(res, 200, agent);
          }
          if (match[2] === 'stop' && req.method === 'POST') {
            if (processes.has(agent.id)) {
              agent.status = 'stopping';
              processes.get(agent.id).kill();
            }
            broadcast();
            return reply(res, 200, { ok: true });
          }
          if (!match[2] && req.method === 'DELETE') {
            if (agent.status !== 'stopped' || processes.has(agent.id)) {
              throw Object.assign(new Error('Stop the agent before removing it'), { status: 409 });
            }
            agents.delete(agent.id);
            for (const [id, edge] of edges) {
              if (edge.source === agent.id || edge.target === agent.id) edges.delete(id);
            }
            for (const ws of terminals.get(agent.id) || []) ws.terminate();
            terminals.delete(agent.id);
            broadcast();
            return reply(res, 200, { ok: true });
          }
          if (!match[2] && req.method === 'PATCH') {
            const updates = {};
            if (body.name !== undefined) {
              if (!validText(body.name, 100)) throw new Error('name must be 1–100 characters');
              updates.name = body.name.trim();
            }
            if (body.note !== undefined) {
              if (typeof body.note !== 'string' || body.note.length > 500) throw new Error('note must be at most 500 characters');
              updates.note = body.note;
            }
            for (const key of ['x', 'y', 'width', 'height']) {
              if (body[key] !== undefined) {
                if (!Number.isFinite(body[key]) || (['width', 'height'].includes(key) && body[key] < 240)) throw new Error(`Invalid ${key}`);
                updates[key] = body[key];
              }
            }
            Object.assign(agent, updates);
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
    listen: async () => {
      unlock = lockCanvas(stateFile);
      let saved;
      try { saved = loadCanvas(stateFile); } // Fail closed: never overwrite a corrupt save.
      catch (error) { unlock(); throw error; }
      if (saved) {
        for (const agent of saved.agents) agents.set(agent.id, agent);
        for (const edge of saved.edges) edges.set(edge.id, edge);
        for (const note of saved.notes) notes.set(note.id, note);
      }
      try {
        await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
      } catch (error) { unlock(); throw error; }
      started = true;
      for (const agent of agents.values()) {
        if (agent.status !== 'running') { agent.status = 'stopped'; continue; }
        try { startAgent(agent, true); }
        catch (error) { agent.status = 'stopped'; agent.restoreWarning = error.message; }
      }
      broadcast();
    },
    close: () => {
      if (closePromise) return closePromise;
      flush(); // Save running intent BEFORE shutdown kills change process status.
      closing = true;
      closePromise = (async () => {
        for (const client of clients) client.end();
        for (const group of terminals.values()) for (const ws of group) ws.terminate();
        wss.close();
        await stopProcesses();
        await new Promise(resolveClose => server.close(resolveClose));
        unlock();
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateFile = resolve(process.env.AGENT_CANVAS_STATE_FILE || join(homedir(), '.agent-canvas', 'canvas.json'));
  const app = createApp({ stateFile });
  app.listen().then(() => console.log(`Agent Canvas API: http://127.0.0.1:${process.env.PORT || 3001}\nCanvas save: ${stateFile}`)).catch(error => { console.error(error.message); process.exit(1); });
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
