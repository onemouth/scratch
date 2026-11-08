import { randomUUID } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { validateTelemetryData } from '../shared/canvas-telemetry.js';

export const MAX_OUTPUT = 80000;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

// Owns process/run/activity state. Domain operations own canvas records; HTTP
// and terminal transport never implement process/session semantics.
export function createAgentRuntime({ agents, spawnAgent, terminals, root, getBaseUrl, isClosing, broadcast, publishImmediate, getMemory = () => null, getMessaging = () => null, getTelemetry = () => null, getQueries = () => null, onChange = () => {} }) {
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
    runs.set(id, { generation: randomUUID(), ready: false, lastTelemetrySeq: 0 });
    activity.delete(id);
    const base = getBaseUrl();
    const instructions = `You are an agent on Agent Canvas. Your agent ID is ${id}. The local canvas API is at ${base}/api. When working with Canvas agents, delegation, messages, progress notes, or card-box cards, read and follow the agent-canvas skill. The skill points to the current API guide. Relationships represent real delegation, not automatic messaging. You may specify or adjust positions and sizes of Agent Canvas objects through the documented API; check conflicts and human interaction locks. Card box positions and viewports remain human-only.${agent.workspace === 'card-box' ? ' You are the single Card box agent. Use the Canvas API for card operations when asked; never directly edit SQLite, Canvas JSON, backup or lock files in your workdir.' : ''}`;
    let child;
    try {
      const memory = getMemory();
      if (!memory || !getMessaging() || !getTelemetry() || !getQueries()) throw new Error('SHM channels are required');
      const notifier = memory.createNotifier();
      runs.get(id).notifier = notifier;
      const messages = getMessaging().createChannel(id, runs.get(id).generation);
      runs.get(id).messages = messages;
      const telemetry = getTelemetry().createChannel(id, runs.get(id).generation);
      runs.get(id).telemetry = telemetry;
      const queries = getQueries().createChannel(id, runs.get(id).generation);
      runs.get(id).queries = queries;
      const common = ['--tui-mode', 'regular', '--extension', join(root, 'server', 'pi-session-tracker.js'),
        '--extension', join(root, 'server', 'pi-canvas-memory.js'),
        '--extension', join(root, 'server', 'pi-canvas-queries.js'),
        '--extension', join(root, 'server', 'pi-canvas-messages.js'), '--skill', join(root, 'skills', 'agent-canvas', 'SKILL.md'), '--append-system-prompt', instructions];
      const args = restoring
        ? [...(exactSession ? ['--session', agent.sessionFile] : ['--resume']), ...common]
        : mode === 'resume' ? ['--resume', ...common]
          : ['--name', agent.name, ...common, ...(agent.task ? ['--', agent.task] : [])];
      const { AGENT_CANVAS_SHARED_MEMORY: _oldSwitch, AGENT_CANVAS_TELEMETRY_TRANSPORT: _oldTransport, AGENT_CANVAS_RUN: _oldToken, ...environment } = process.env;
      child = spawnAgent('pi', args, {
        cwd: workdir, cols: 50, rows: 16, name: 'xterm-256color',
        env: { ...environment, TERM: 'xterm-256color', PI_IMAGE_PROTOCOL: 'none', AGENT_CANVAS_URL: base, AGENT_CANVAS_ID: id,
          AGENT_CANVAS_SHM_NAME: memory.name, AGENT_CANVAS_SHM_EPOCH: memory.epoch, AGENT_CANVAS_SHM_NOTIFY: notifier.name,
          AGENT_CANVAS_SHM_MESSAGES: JSON.stringify(messages.config),
          AGENT_CANVAS_SHM_TELEMETRY: JSON.stringify(telemetry.config),
          AGENT_CANVAS_SHM_QUERIES: JSON.stringify(queries.config) },
      });
    } catch (error) {
      runs.get(id)?.queries?.close();
      runs.get(id)?.telemetry?.close();
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
      run?.queries?.close();
      run?.telemetry?.close();
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

  const applyTelemetry = (id, generation, frame) => {
    const agent = requireAgent(id), run = runs.get(id);
    if (!run || run.generation !== generation || !run.telemetry || agent.status !== 'running') {
      throw Object.assign(failure('Stale telemetry process', 409), { code: 'TELEMETRY_GENERATION' });
    }
    validateTelemetryData(frame.kind, frame.data);
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) throw failure('Invalid telemetry sequence');
    if (frame.seq <= run.lastTelemetrySeq) return { ok: true };
    run.lastTelemetrySeq = frame.seq;
    if (frame.kind === 'session') {
      agent.sessionFile = frame.data.sessionFile; agent.sessionId = frame.data.sessionId;
      run.ready = true; agent.restoreWarning = '';
      broadcast();
    } else if (frame.kind === 'activity') {
      activity.set(id, { state: frame.data.state, seq: frame.seq, ...(frame.data.summary ? { summary: frame.data.summary.trim() } : {}) });
      notify();
      publishImmediate(); // No disk write/coalescing of a fast working → idle turn.
    } else {
      agent.note = frame.data.text; broadcast();
    }
    return { ok: true };
  };
  return {
    applyTelemetry,
    processes, startAgent, stopProcesses, requireAgent, describe, notify,
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
