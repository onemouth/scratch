import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const MAX_OUTPUT = 80000;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function jsonl(stream, handle) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const parse = (line) => { if (line.trim()) { try { handle(JSON.parse(line)); } catch { /* ignore malformed RPC records */ } } };
  stream.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      parse(buffer.slice(0, i).replace(/\r$/, ''));
      buffer = buffer.slice(i + 1);
    }
  });
  stream.on('end', () => { buffer += decoder.end(); parse(buffer); });
}

export function createApp({ port = Number(process.env.PORT || 3001), spawnAgent = spawn } = {}) {
  const agents = new Map();
  const processes = new Map();
  const edges = new Map();
  const clients = new Set();
  let pending = false;
  let server;
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
    broadcast();
  };
  const send = (child, command) => {
    if (!child?.stdin?.writable) throw new Error('Agent process is not available');
    child.stdin.write(`${JSON.stringify(command)}\n`);
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
      id, name: body.name.trim(), workdir, task: body.task.trim(), status: 'starting', output: '',
      note: '', x: Number.isFinite(body.x) ? body.x : 100 + (index % 3) * 490,
      y: Number.isFinite(body.y) ? body.y : 100 + Math.floor(index / 3) * 380,
      width: 440, height: 320,
    };
    const base = `http://127.0.0.1:${port}`;
    const instructions = `You are an agent on Agent Canvas. Your agent ID is ${id}. The canvas API is at ${base}/api. Use your bash tool with curl to interact with it. GET /api/state reads all agents and delegation relationships. POST /api/agents with JSON {"name":"...","workdir":"absolute path","task":"...","parentId":"${id}"} creates a child agent and a delegation edge. POST /api/edges with {"source":"${id}","target":"agent-id"} records delegation without sending messages. PATCH /api/agents/${id} with {"note":"short progress summary"} updates your note. Relationships represent real delegation; only create them when delegating actual work. Never modify canvas coordinates. This API is local to this server.`;
    let child;
    try {
      child = spawnAgent('pi', ['--mode', 'rpc', '--no-session', '--name', agent.name, '--append-system-prompt', instructions], {
        cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGENT_CANVAS_URL: base, AGENT_CANVAS_ID: id },
      });
    } catch (error) { throw Object.assign(new Error(`Could not start pi: ${error.message}`), { status: 500 }); }
    agents.set(id, agent);
    processes.set(id, child);
    if (body.parentId) connect(body.parentId, id);
    output(agent, `> ${agent.task}\n\n`);
    child.on('error', (error) => { output(agent, `\n[process error] ${error.message}\n`); agent.status = 'stopped'; broadcast(); });
    child.on('exit', (code, signal) => {
      processes.delete(id);
      agent.status = 'stopped';
      output(agent, `\n[process exited${signal ? `: ${signal}` : `: ${code}`} ]\n`);
    });
    child.stderr.on('data', (chunk) => output(agent, `\n[pi] ${chunk.toString()}`));
    jsonl(child.stdout, (event) => {
      if (event.type === 'agent_start') agent.status = 'working';
      if (event.type === 'agent_settled') { agent.status = 'idle'; output(agent, '\n'); }
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') output(agent, event.assistantMessageEvent.delta);
      if (event.type === 'tool_execution_start') output(agent, `\n$ ${event.toolName}${event.args?.command ? ` ${event.args.command}` : ''}\n`);
      if (event.type === 'tool_execution_end') {
        const text = event.result?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (text) output(agent, `${text.slice(0, 5000)}\n`);
      }
      if (event.type === 'response' && !event.success) output(agent, `\n[error] ${event.error}\n`);
      if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        // MVP has no modal bridge: cancel rather than leave the agent blocked indefinitely.
        send(child, { type: 'extension_ui_response', id: event.id, cancelled: true });
        output(agent, `\n[unsupported dialog: ${event.method}]\n`);
      }
      broadcast();
    });
    try { send(child, { type: 'prompt', message: agent.task }); }
    catch { /* child error/exit handlers will update status */ }
    broadcast();
    return agent;
  };

  const reply = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, 'http://127.0.0.1:5173'].includes(req.headers.origin)) {
      return reply(res, 403, { error: 'Cross-origin requests are not allowed' });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot());
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
        const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(prompt|stop|abort))?$/);
        if (match) {
          const agent = requireAgent(match[1]);
          if (match[2] === 'prompt' && req.method === 'POST') {
            if (!validText(body.message)) throw new Error('message is required');
            if (agent.status === 'stopped') throw new Error('Agent is stopped');
            send(processes.get(agent.id), { type: 'prompt', message: body.message.trim(), streamingBehavior: 'followUp' });
            output(agent, `\n> ${body.message.trim()}\n`);
            return reply(res, 200, { ok: true });
          }
          if (match[2] === 'abort' && req.method === 'POST') {
            if (agent.status === 'stopped') throw new Error('Agent is stopped');
            send(processes.get(agent.id), { type: 'clear_queue' });
            send(processes.get(agent.id), { type: 'abort' });
            return reply(res, 200, { ok: true });
          }
          if (match[2] === 'stop' && req.method === 'POST') {
            processes.get(agent.id)?.kill('SIGTERM');
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
    // Serve production build only; Vite handles assets during development.
    const file = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) return reply(res, 404, { error: 'Run npm run build or npm run dev' });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };
  server = http.createServer((req, res) => { handler(req, res).catch((error) => reply(res, 500, { error: error.message })); });
  return {
    server, snapshot,
    listen: () => new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen)),
    close: () => new Promise((resolveClose) => {
      for (const client of clients) client.end();
      for (const child of processes.values()) child.kill('SIGTERM');
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
