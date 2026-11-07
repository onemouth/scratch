import { randomUUID } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { WebSocket } from 'ws';
import { validText } from './validation.js';

export const MAX_OUTPUT = 80000;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

// Owns process/run/activity state. Domain operations own canvas records; HTTP
// and terminal transport never implement process/session semantics.
export function createAgentRuntime({ agents, spawnAgent, terminals, root, getBaseUrl, isClosing, broadcast, publishImmediate, getMemory = () => null, getMessaging = () => null, onChange = () => {} }) {
  const processes = new Map(), runs = new Map(), activity = new Map();
  const notify = onChange;
  const requireAgent = id => {
    const agent = agents.get(id);
    if (!agent) throw failure('Agent not found', 404);
    return agent;
  };
  const describe = (agent, { includeOutput = false } = {}) => {
    const { output: _output, ...metadata } = agent;
    const current = activity.get(agent.id);
    return { ...metadata, ...(includeOutput ? { output: agent.output } : {}), processGeneration: runs.get(agent.id)?.generation ?? null, activity: current?.state ?? 'unknown', ...(current?.summary ? { notificationSummary: current.summary } : {}) };
  };
  const output = (agent, text) => {
    agent.output = (agent.output + text).slice(-MAX_OUTPUT);
    for (const socket of terminals.get(agent.id) || []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
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
    runs.set(id, { token: runToken, generation: randomUUID(), ready: false });
    activity.delete(id);
    const base = getBaseUrl();
    const instructions = `You are an agent on Agent Canvas. Your agent ID is ${id}. The local canvas API is at ${base}/api. When working with Canvas agents, delegation, messages, progress notes, or card-box cards, read and follow the agent-canvas skill. The skill points to the current API guide. Relationships represent real delegation, not automatic messaging. You may specify or adjust positions and sizes of Agent Canvas objects through the documented API; check conflicts and human interaction locks. Card box positions and viewports remain human-only.${agent.workspace === 'card-box' ? ' You are the single Card box agent. Use the Canvas API for card operations when asked; never directly edit SQLite, Canvas JSON, backup or lock files in your workdir.' : ''}`;
    let child;
    try {
      const memory = getMemory();
      const notifier = memory?.createNotifier();
      runs.get(id).notifier = notifier;
      const messages = getMessaging()?.createChannel(id, runs.get(id).generation);
      runs.get(id).messages = messages;
      const common = ['--tui-mode', 'regular', '--extension', join(root, 'server', 'pi-session-tracker.js'),
        ...(memory ? ['--extension', join(root, 'server', 'pi-canvas-memory.js')] : []),
        ...(messages ? ['--extension', join(root, 'server', 'pi-canvas-messages.js')] : []), '--skill', join(root, 'skills', 'agent-canvas', 'SKILL.md'), '--append-system-prompt', instructions];
      const args = restoring
        ? [...(exactSession ? ['--session', agent.sessionFile] : ['--resume']), ...common]
        : mode === 'resume' ? ['--resume', ...common]
          : ['--name', agent.name, ...common, ...(agent.task ? ['--', agent.task] : [])];
      child = spawnAgent('pi', args, {
        cwd: workdir, cols: 50, rows: 16, name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'none', AGENT_CANVAS_URL: base, AGENT_CANVAS_ID: id, AGENT_CANVAS_RUN: runToken,
          AGENT_CANVAS_SHM_NAME: memory?.name ?? '', AGENT_CANVAS_SHM_EPOCH: memory?.epoch ?? '', AGENT_CANVAS_SHM_NOTIFY: runs.get(id)?.notifier?.name ?? '',
          AGENT_CANVAS_SHM_MESSAGES: messages ? JSON.stringify(messages.config) : '' },
      });
    } catch (error) {
      runs.get(id)?.messages?.close();
      runs.get(id)?.notifier?.close();
      runs.delete(id);
      activity.delete(id);
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
      activity.delete(id);
      const wasStopping = agent.status === 'stopping';
      agent.status = 'stopped';
      notify(); // Observe the old run ending even if restore immediately replaces it.
      run?.messages?.close();
      run?.notifier?.close();
      if (!isClosing() && !wasStopping && restoring && exactSession && !run?.ready && exitCode !== 0 && agents.has(id)) {
        try { startAgent(agent, true, true); return; }
        catch (error) { agent.restoreWarning = error.message; }
      }
      output(agent, `\r\n[Pi exited: ${signal ? `signal ${signal}` : `code ${exitCode}`}]\r\n`);
      broadcast();
    });
    broadcast();
    return agent;
  };

  const stopProcesses = async (children = [...processes.values()]) => {
    await Promise.all(children.map(child => new Promise((resolveStop, rejectStop) => {
      let timeout;
      let escalation;
      const cleanup = () => { clearTimeout(timeout); clearTimeout(escalation); };
      child.onExit(() => { cleanup(); resolveStop(); });
      escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exit may already be in flight */ } }, 1500);
      timeout = setTimeout(() => { cleanup(); rejectStop(new Error('A Pi process did not stop; Canvas has not been cleared')); }, 3500);
      try { child.kill(); } catch (error) { cleanup(); rejectStop(error); }
    })));
  };

  const reportSession = (id, body) => {
    const agent = requireAgent(id), run = runs.get(id);
    if (!run || body.runToken !== run.token) throw failure('Stale Pi process', 409);
    if (body.sessionFile !== null && (!validText(body.sessionFile, 4096) || !isAbsolute(body.sessionFile))) throw failure('Invalid session file');
    if (!validText(body.sessionId, 100)) throw failure('Invalid session ID');
    agent.sessionFile = body.sessionFile; agent.sessionId = body.sessionId;
    run.ready = true; agent.restoreWarning = '';
    broadcast(); return { ok: true };
  };
  const reportActivity = (id, body) => {
    requireAgent(id);
    const run = runs.get(id);
    if (!run || body.runToken !== run.token) throw failure('Stale Pi process', 409);
    if (!['working', 'idle'].includes(body.state) || !Number.isSafeInteger(body.seq) || body.seq < 0) throw failure('Invalid activity report');
    if (body.summary !== undefined && (body.state !== 'idle' || !validText(body.summary, 240))) throw failure('Invalid activity summary');
    const previous = activity.get(id);
    if (!previous || body.seq > previous.seq) {
      activity.set(id, { state: body.state, seq: body.seq, ...(body.summary ? { summary: body.summary.trim() } : {}) });
      notify();
      publishImmediate(); // No disk write/coalescing of a fast working → idle turn.
    }
    return { ok: true };
  };
  return {
    processes, startAgent, stopProcesses, requireAgent, describe, notify, reportSession, reportActivity,
    list: () => [...agents.values()].map(agent => describe(agent)),
    get: id => describe(requireAgent(id)),
    read: id => ({ id, output: requireAgent(id).output, maxCharacters: MAX_OUTPUT }),
    forget: id => { runs.delete(id); activity.delete(id); },
    stop: id => {
      const agent = requireAgent(id);
      if (processes.has(id)) { agent.status = 'stopping'; processes.get(id).kill(); }
      broadcast(); return { ok: true };
    },
  };
}
