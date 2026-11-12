import http from 'node:http';
import pty from 'node-pty';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicOrigin } from './public-origin.js';
import { initializeMedia } from './card-media-store.js';
import { initializeInteractiveAssets } from './interactive-asset-store.js';
import { CardStore } from './card-store.js';
import { CardViews } from './card-views.js';
import { CanvasLayout } from './canvas-layout.js';
import { storagePaths } from './storage-paths.js';
import { lockCanvas, loadCanvas, saveCanvas } from './canvas-store.js';
import { createAgentRuntime } from './agent-runtime.js';
import { createCanvasOperations } from './canvas-operations.js';
import { createHttpHandler, reply } from './http-routes.js';
import { attachTerminalTransport } from './terminal-transport.js';
import { createCanvasMemory } from './canvas-memory.js';
import { scoreboardRows } from '../shared/scoreboard.js';
import { createCanvasMessaging } from './canvas-messages.js';
import { createCanvasQueries } from './canvas-queries.js';
import { queryError, queryPage } from '../shared/canvas-queries.js';
import { createCanvasTelemetry } from './canvas-telemetry.js';
import { createVault } from './vault.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const apiGuide = join(root, 'docs', 'agent-api.md');

export function createApp({ port = Number(process.env.PORT || 3001), spawnAgent = pty.spawn, stateFile = null, cardsFile = stateFile ? stateFile + '.cards.sqlite' : ':memory:',
  publicOrigin = process.env.AGENT_CANVAS_PUBLIC_ORIGIN,
  sharedMemory = {},
  mediaDirectory = cardsFile === ':memory:' ? null : dirname(resolve(cardsFile)),
  interactiveMediaRoot = join(homedir(), 'Documents', 'agent-canvas', 'media'),
  sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions') } = {}) {
  if (!sharedMemory || typeof sharedMemory !== 'object') throw new Error('SHM is required; HTTP-only mode has been removed');
  const trustedPublicOrigin = parsePublicOrigin(publicOrigin);
  const agents = new Map();
  const quietLayoutLaunches = new Set();
  const edges = new Map();
  const notes = new Map();
  const cardPlacements = new Map();
  const canvasLayout = new CanvasLayout(() => [
    ...[...agents.values()].filter(agent => agent.workspace !== 'card-box').map(agent => ({ kind: 'agent', ...geometry(agent) })),
    ...[...notes.values()].map(note => ({ kind: 'note', ...geometry(note) })),
    ...[...cardPlacements.values()].map(placement => ({ kind: 'card', ...geometry(placement) })),
  ]);
  function geometry({ id, x, y, width, height }) { return { id, x, y, width, height }; }
  let views;
  let cards;
  let memory, messaging, telemetry, queries, vault;
  const clients = new Set();
  const terminals = new Map();
  let pending = false;
  let closing = false;
  let started = false;
  let resetting = false;
  let closePromise;
  let unlock = () => {};
  let unlockCards = () => {};
  let saveTimer;
  let saveError = '';
  const snapshot = (live = true, { includeOutput = true } = {}) => ({
    agents: [...agents.values()].map(agent => live ? {
      ...runtime.describe(agent, { includeOutput }),
      inbox: messaging?.inbox.summary(agent.id),
      ...(quietLayoutLaunches.has(agent.id) ? { suppressAutoFocus: true } : {}),
    } : agent),
    edges: [...edges.values()], notes: [...notes.values()], cardPlacements: [...cardPlacements.values()],
    cardBox: views?.snapshot({ live }) ?? { placements: [] },
    ...(live ? { scoreboard: scoreboardRows(runtime.list()), cards: cards?.list({ includeInteractiveSource: false }) ?? [], vault: vault?.status() } : {}),
    persistence: { enabled: !!stateFile, error: saveError },
  });
  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!started) return;
    try { saveCanvas(stateFile, snapshot(false)); saveError = ''; }
    catch (error) { saveError = error.message; console.error('Canvas save failed:', error.message); }
  };
  const broadcast = () => {
    runtime.notify();
    if (closing || resetting) return;
    if (views) views.revision++;
    if (stateFile) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { flush(); publish(); }, 250); }
    publish();
  };
  const publishImmediate = () => {
    if (closing) return;
    memory?.publish();
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) client.write(data);
  };
  const publish = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; publishImmediate(); }, 50);
  };
  const runtime = createAgentRuntime({
    agents, spawnAgent, terminals, root, broadcast, publishImmediate,
    getBaseUrl: () => `http://127.0.0.1:${server.address()?.port || port}`,
    isClosing: () => closing,
    getMemory: () => memory,
    getMessaging: () => messaging,
    getTelemetry: () => telemetry,
    getQueries: () => queries,
    getVault: () => vault,
    onChange: () => { memory?.observeAgents(); vault?.observeProcesses(); },
  });
  const { startAgent, stopProcesses } = runtime;
  const operate = createCanvasOperations({
    agents, quietLayoutLaunches, notes, edges, cardPlacements, canvasLayout, terminals, runtime,
    getCards: () => cards, getViews: () => views, getInbox: () => messaging?.inbox, cardsFile, mediaDirectory, interactiveMediaRoot,
    broadcast, flush, publish, isUnavailable: () => closing || resetting,
    setResetting: value => { resetting = value; }, cancelSave: () => clearTimeout(saveTimer),
    getSaveError: () => saveError,
  });
  const allowedOrigin = (origin) => !origin || [`http://127.0.0.1:${server.address()?.port || port}`, 'http://127.0.0.1:5173', trustedPublicOrigin].includes(origin);
  const handler = createHttpHandler({
    port, allowedOrigin, snapshot, clients, sessionsRoot, apiGuide,
    getBackendUrl: () => `http://127.0.0.1:${server.address().port}`,
    getCards: () => cards, getVault: () => vault, mediaDirectory, operate, broadcast, dist,
    isUnavailable: () => closing || resetting,
  });
  const server = http.createServer((req, res) => { handler(req, res).catch((error) => reply(res, 500, { error: error.message })); });
  const wss = attachTerminalTransport({ server, agents, processes: runtime.processes, terminals, allowedOrigin });
  return {
    server, snapshot, runtime,
    get vaultControlCode() { return vault?.controlCode; },
    get sharedMemory() { return memory ? { name: memory.name, epoch: memory.epoch, error: memory.error } : null; },
    listen: async () => {
      unlock = lockCanvas(stateFile);
      let saved;
      try {
        saved = loadCanvas(stateFile);
        unlockCards = cardsFile === ':memory:' ? () => {} : lockCanvas(cardsFile);
        cards = new CardStore(cardsFile);
        cards.list(); // Validate the database before accepting requests.
        await initializeMedia(mediaDirectory);
        await initializeInteractiveAssets(mediaDirectory);
        await cards.backup();
      } // Fail closed: never overwrite a corrupt save.
      catch (error) { cards?.close(); unlockCards(); unlock(); throw error; }
      if (saved) {
        for (const agent of saved.agents) agents.set(agent.id, agent);
        for (const edge of saved.edges) edges.set(edge.id, edge);
        for (const note of saved.notes) notes.set(note.id, note);
        const cardIds = new Set(cards.list().map(card => card.id));
        for (const placement of saved.cardPlacements || []) if (cardIds.has(placement.cardId)) cardPlacements.set(placement.id, placement);
      }
      try {
        views = new CardViews(saved?.cardBox, cards.list());
        vault = createVault({ cards, getAgent: id => agents.has(id) ? runtime.get(id) : null, onChange: publish });
        memory = createCanvasMemory({
          ...sharedMemory,
          getAgents: () => runtime.list(),
          getState: () => ({ agents: runtime.list(), edges: [...edges.values()], notes: [...notes.values()],
            cards: cards.list({ includeInteractiveSource: false }), cardPlacements: [...cardPlacements.values()] }),
        });
        messaging = createCanvasMessaging({ epoch: memory.epoch,
          getAgent: id => agents.has(id) ? runtime.describe(agents.get(id)) : null, onChange: publish });
        telemetry = createCanvasTelemetry({ epoch: memory.epoch, apply: runtime.applyTelemetry });
        queries = createCanvasQueries({ epoch: memory.epoch, execute(id, generation, kind, params) {
          if (closing || resetting) throw queryError('QUERY_UNAVAILABLE', 'Canvas is shutting down or resetting');
          const requester = runtime.get(id);
          if (requester.status !== 'running' || requester.processGeneration !== generation) throw queryError('QUERY_GENERATION', 'Stale query process');
          if (kind === 'agent') return { agent: runtime.get(params.agentId) };
          if (kind === 'agents') return queryPage('agents', runtime.list(), params);
          return queryPage('objects', canvasLayout.snapshot().objects, params);
        } });
        await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
      } catch (error) { vault?.close(); queries?.close(); telemetry?.close(); messaging?.close(); memory?.close(); cards.close(); unlockCards(); unlock(); throw error; }
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
      vault?.close(); queries?.close(); telemetry?.close(); messaging?.close(); memory?.close();
      closePromise = (async () => {
        for (const client of clients) client.end();
        for (const group of terminals.values()) for (const ws of group) ws.terminate();
        wss.close();
        await stopProcesses();
        await new Promise(resolveClose => server.close(resolveClose));
        cards?.close();
        unlockCards();
        unlock();
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let paths;
  try { paths = storagePaths(); }
  catch (error) { console.error('Cannot migrate Canvas data:', error.message); process.exit(1); }
  const { stateFile, cardsFile, migrated } = paths;
  if (migrated) console.log('Migrated data to ~/Documents/agent-canvas; originals retained in ~/.agent-canvas.');
  const app = createApp({ stateFile, cardsFile });
  app.listen().then(() => console.log(`Agent Canvas API: http://127.0.0.1:${process.env.PORT || 3001}\nCanvas save: ${stateFile}\nCard database: ${cardsFile}\nVault control code (human UI only; do not share with Agents): ${app.vaultControlCode}`)).catch(error => { console.error(error.message); process.exit(1); });
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
