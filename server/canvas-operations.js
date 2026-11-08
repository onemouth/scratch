import { randomUUID } from 'node:crypto';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { validText } from './validation.js';
import { LAYOUT_KEYS, hasLayout, layoutPatch } from './canvas-layout.js';
import { validateViewport } from './card-views.js';
import { searchCards } from '../shared/card-search.js';
import { importInteractiveAsset, removeInteractiveAssetFile } from './interactive-asset-store.js';

// Canvas domain operations. No IncomingMessage/ServerResponse, HTTP body
// parsing, origin policy or terminal protocol belongs in this layer.
export function createCanvasOperations({
  agents, quietLayoutLaunches, notes, edges, cardPlacements, canvasLayout, terminals,
  runtime, getCards, getViews, cardsFile, mediaDirectory, interactiveMediaRoot,
  broadcast, flush, publish, isUnavailable, setResetting, cancelSave, getSaveError,
}) {
  const { processes, startAgent, stopProcesses, requireAgent } = runtime;
  const result = (status, value) => ({ status, value });
  const validCardPlacementValue = (id, key, value) => ['x', 'y', 'width', 'height'].includes(key) && Number.isFinite(value) &&
    (!['width', 'height'].includes(key) || value >= (key === 'width' && getCards().get(id).type === 'interactive' ? 320 : 240));
  const edgeLabel = (value) => {
    if (typeof value !== 'string' || !validText(value, 120)) throw new Error('label must be 1–120 characters');
    return value.trim();
  };
  const connect = (source, target, label = 'delegates') => {
    if ([requireAgent(source), requireAgent(target)].some(agent => agent.workspace === 'card-box')) throw new Error('Card box agent does not support delegation edges');
    const displayLabel = edgeLabel(label);
    if (source === target) throw new Error('Cannot delegate to self');
    const existing = [...edges.values()].find((edge) => edge.source === source && edge.target === target);
    if (existing) return existing;
    const edge = { id: randomUUID(), source, target, type: 'delegates', label: displayLabel };
    edges.set(edge.id, edge);
    broadcast();
    return edge;
  };
  const createAgent = (body, workspace = 'agents', humanLayout = false) => {
    const mode = body.mode ?? 'new';
    if (!['new', 'resume'].includes(mode)) throw new Error('mode must be new or resume');
    if (!validText(body.name, 100) || !validText(body.workdir, 2048)) throw new Error('name and workdir are required');
    if (mode === 'new' && body.task !== undefined && !validText(body.task)) throw new Error('task must be non-empty when provided');
    if (mode === 'resume' && body.task !== undefined) throw new Error('task cannot be set when resuming a session');
    const workdir = resolve(body.workdir);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error('workdir must be an existing directory');
    if (body.parentId && requireAgent(body.parentId).workspace === 'card-box') throw new Error('Card box agent does not support delegation');
    const id = randomUUID();
    const index = agents.size;
    const agent = {
      id, workspace, name: body.name.trim(), workdir, mode, task: mode === 'new' ? (body.task?.trim() ?? '') : '', status: 'running', output: '',
      note: '', x: Number.isFinite(body.x) ? body.x : 100 + (index % 3) * 490,
      y: Number.isFinite(body.y) ? body.y : 100 + Math.floor(index / 3) * 380,
      width: 440, height: 320,
    };
    if (workspace === 'card-box') Object.assign(agent, { x: 40, y: 80, width: 440, height: 420 });
    else if (hasLayout(body)) {
      Object.assign(agent, layoutPatch(body, { width: 320, height: 240 }));
      if (!humanLayout) canvasLayout.assertAvailable(agent);
    }
    if (workspace === 'agents' && hasLayout(body) && !humanLayout) quietLayoutLaunches.add(id);
    try { startAgent(agent); }
    catch (error) { quietLayoutLaunches.delete(id); throw error; }
    if (body.parentId) connect(body.parentId, id);
    return agent;
  };

  return async ({ path, method, body = {}, query = new URLSearchParams(), humanLayout = false }) => {
    if (isUnavailable()) return result(503, { error: 'Canvas is shutting down or resetting' });
    const cards = getCards(), views = getViews();
    const mediaSlot = path.match(new RegExp('^/api/cards/([^/]+)/media/(image|audio)$'));
    if (path === '/api/agents' && method === 'GET') return result(200, { agents: runtime.list() });
    const agentRead = path.match(/^\/api\/agents\/([^/]+)(?:\/(output))?$/);
    if (agentRead && method === 'GET') return result(200, agentRead[2] === 'output' ? runtime.read(agentRead[1]) : runtime.get(agentRead[1]));
    if (path === '/api/canvas/layout' && method === 'GET') return result(200, canvasLayout.snapshot());
    const interactionMatch = path.match(/^\/api\/canvas\/layout-interactions\/(agent|note|card)\/([^/]+)$/);
    if (interactionMatch && method === 'POST') {
      if (!humanLayout) return result(403, { error: 'Layout interactions are reserved for browser gestures' });
      if (Object.keys(body).some(key => !['owner', 'action'].includes(key))) throw new Error('Invalid layout interaction fields');
      return result(200, canvasLayout.interaction(interactionMatch[1], interactionMatch[2], body.owner, body.action));
    }
    if (mediaSlot && method === 'DELETE') {
      if (Object.keys(body).some(key => key !== 'attachmentId') || typeof body.attachmentId !== 'string') throw new Error('Removal requires the current attachmentId');
      const [, id, kind] = mediaSlot;
      const card = cards.setMedia(id, kind, null, body.attachmentId);
      broadcast(); return result(200, card);
    }
    const interactiveImport = path.match(/^\/api\/cards\/([^/]+)\/interactive-assets\/import$/);
    if (interactiveImport && method === 'POST') {
      if (Object.keys(body).some(key => !['kind', 'source', 'name'].includes(key))) throw new Error('Asset import accepts kind, source and name');
      const card = await importInteractiveAsset({ cardId: interactiveImport[1], kind: body.kind, source: body.source, name: body.name,
        mediaRoot: interactiveMediaRoot, directory: mediaDirectory, commit: file => cards.addInteractiveAsset(interactiveImport[1], file) });
      broadcast(); return result(201, card);
    }
    const interactiveAsset = path.match(/^\/api\/cards\/([^/]+)\/interactive-assets\/([^/]+)$/);
    if (interactiveAsset && method === 'DELETE') {
      if (Object.keys(body).length) throw new Error('Asset removal takes an empty object');
      const name = decodeURIComponent(interactiveAsset[2]);
      const removed = cards.removeInteractiveAsset(interactiveAsset[1], name);
      await removeInteractiveAssetFile(mediaDirectory, removed.file.filename);
      broadcast(); return result(200, removed.card);
    }
    if (path === '/api/canvas/reset' && method === 'POST') {
      if (body.confirm !== true) throw new Error('Reset requires confirm: true');
      setResetting(true);
      cancelSave();
      const removed = [...agents.values()].filter(agent => agent.workspace !== 'card-box');
      for (const agent of removed) if (processes.has(agent.id)) agent.status = 'stopping';
      try { await stopProcesses(removed.map(agent => processes.get(agent.id)).filter(Boolean)); }
      catch (error) { setResetting(false); broadcast(); throw error; }
      for (const agent of removed) {
        for (const ws of terminals.get(agent.id) || []) ws.terminate();
        terminals.delete(agent.id); processes.delete(agent.id); runtime.forget(agent.id); agents.delete(agent.id);
      }
      notes.clear(); edges.clear(); cardPlacements.clear(); canvasLayout.clear(); quietLayoutLaunches.clear();
      setResetting(false);
      flush(); publish();
      if (getSaveError()) return result(500, { error: `Canvas cleared in memory but could not save reset: ${getSaveError()}` });
      return result(200, { ok: true });
    }
    if (path === '/api/card-box/agent' && method === 'POST') {
      if (Object.keys(body).length) throw new Error('Card box agent launch takes an empty object');
      if ([...agents.values()].some(agent => agent.workspace === 'card-box')) return result(409, { error: 'Card box agent already exists; resume its conversation' });
      const workdir = cardsFile === ':memory:' ? join(homedir(), 'Documents', 'agent-canvas') : dirname(resolve(cardsFile));
      mkdirSync(workdir, { recursive: true, mode: 0o700 });
      return result(201, createAgent({ name: 'Card box', workdir, mode: 'new' }, 'card-box'));
    }
    const boxPlacementMatch = path.match(/^\/api\/card-box\/placements\/([^/]+)$/);
    if (boxPlacementMatch && method === 'PATCH') {
      const placement = views.active.placements.get(boxPlacementMatch[1]);
      if (!placement) return result(404, { error: 'Card box placement not found' });
      const updates = {};
      for (const [key, value] of Object.entries(body)) {
        if (!validCardPlacementValue(placement.cardId, key, value)) throw new Error('Invalid placement dimensions');
        updates[key] = value;
      }
      Object.assign(placement, updates); broadcast(); return result(200, placement);
    }
    if (path === '/api/card-box/views' && method === 'GET') return result(200, views.snapshot());
    if (path === '/api/card-box/views' && method === 'POST') {
      if (Object.keys(body).some(k => !['name', 'cardIds', 'fromViewId', 'temporaryAction', 'saveName'].includes(k))) throw new Error('Invalid view creation fields');
      views.create(body, cards.list()); broadcast(); return result(201, views.snapshot());
    }
    const viewMatch = path.match(/^\/api\/card-box\/views\/([^/]+)(?:\/(activate|save|cards|viewport)(?:\/([^/]+))?)?$/);
    if (viewMatch) {
      const [, id, action, memberId] = viewMatch;
      const view = views.get(id);
      if (memberId && action !== 'cards') return result(404, { error: 'Unknown view operation' });
      const allowed = action === 'activate' ? ['fromViewId','temporaryAction','saveName'] : action === 'save' ? ['name'] : action === 'viewport' ? ['x','y','zoom'] : action === 'cards' && method === 'PATCH' ? ['x','y','width','height'] : action === 'cards' ? [] : method === 'DELETE' ? ['confirm','fromViewId'] : ['name'];
      if (Object.keys(body).some(k => !allowed.includes(k))) throw new Error('Invalid view operation fields');
      if (!action && method === 'PATCH') {
        if (Object.keys(body).some(k => k !== 'name')) throw new Error('Only view name is editable');
        views.rename(id, body.name);
      } else if (!action && method === 'DELETE') views.remove(id, body, cards.list());
      else if (action === 'activate' && method === 'POST') views.activate(id, body, cards.list());
      else if (action === 'save' && method === 'POST') views.save(id, body.name);
      else if (action === 'viewport' && method === 'PATCH') view.viewport = validateViewport(body);
      else if (action === 'cards' && memberId && method === 'POST') views.add(id, cards.get(memberId), cards.list());
      else if (action === 'cards' && memberId && method === 'DELETE') views.removeCard(id, memberId, cards.list());
      else if (action === 'cards' && memberId && method === 'PATCH') {
        const placement = view.placements.get(memberId);
        if (!placement) return result(404, { error: 'View placement not found' });
        for (const [k, v] of Object.entries(body)) if (!validCardPlacementValue(memberId, k, v)) throw new Error('Invalid placement dimensions');
        Object.assign(placement, body);
      } else return result(405, { error: 'Unsupported view operation' });
      broadcast(); return result(200, views.snapshot());
    }
    if (path === '/api/cards' && method === 'GET') {
      const all = cards.list({ includeInteractiveSource: false });
      if (!query.has('q')) return result(200, { cards: all });
      const matches = searchCards(all, query.get('q'));
      const limit = Number(query.get('limit') ?? 24), offset = Number(query.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid search pagination');
      return result(200, { cards: matches.slice(offset, offset + limit), total: matches.length, limit, offset });
    }
    if (path === '/api/cards' && method === 'POST') {
      if (Object.keys(body).some(key => !['type', 'content', 'title', 'html', 'css', 'javascript', 'tags', 'links', 'place', ...LAYOUT_KEYS].includes(key))) throw new Error('Invalid card creation fields');
      if (body.place !== undefined && typeof body.place !== 'boolean') throw new Error('place must be boolean');
      if (body.place === false && hasLayout(body)) throw new Error('Layout fields require an Agent Canvas placement (place: true)');
      const interactive = body.type === 'interactive';
      const rect = { x: 0, y: 0, ...(interactive ? { width: 560, height: 420 } : { width: 340, height: 320 }), ...layoutPatch(body, { width: interactive ? 320 : 240, height: 240 }) };
      if (hasLayout(body) && !humanLayout) canvasLayout.assertAvailable(rect);
      const cardInput = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'place' && !LAYOUT_KEYS.includes(key)));
      const card = cards.create(cardInput);
      views.addNew(card, cards.list());
      if (body.place !== false) cardPlacements.set(card.id, { id: card.id, cardId: card.id, ...rect });
      broadcast(); return result(201, card);
    }
    const cardMatch = path.match(/^\/api\/cards\/([^/]+)$/);
    if (cardMatch) {
      const id = cardMatch[1];
      if (method === 'GET') return result(200, cards.get(id));
      if (method === 'PATCH') {
        const card = cards.get(id);
        const allowed = card.type === 'interactive' ? ['title', 'html', 'css', 'javascript', 'tags', 'links'] : ['content', 'tags', 'links'];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error(`Editable fields for ${card.type} cards: ${allowed.join(', ')}; ID and type are immutable`);
        const updated = cards.update(id, body); broadcast(); return result(200, updated);
      }
      if (method === 'DELETE') {
        if (body.confirm !== true) throw new Error('Permanent deletion requires confirm: true');
        const files = cards.get(id).type === 'interactive' ? cards.get(id).assets.map(asset => cards.interactiveAssetFile(asset.id).filename) : [];
        cards.delete(id);
        await Promise.all(files.map(filename => removeInteractiveAssetFile(mediaDirectory, filename)));
        cardPlacements.delete(id); canvasLayout.forget('card', id); views.prune(cards.list()); broadcast(); return result(200, { ok: true });
      }
    }
    const placeCard = path.match(/^\/api\/cards\/([^/]+)\/placement$/);
    if (placeCard && method === 'POST') {
      const card = cards.get(placeCard[1]);
      if (Object.keys(body).some(key => !LAYOUT_KEYS.includes(key))) throw new Error('Placement accepts only x, y, width and height');
      const existing = cardPlacements.get(card.id);
      if (existing && hasLayout(body)) return result(409, { error: 'Card is already placed; use PATCH to change its layout' });
      const placement = existing || { id: card.id, cardId: card.id, x: 0, y: 0, ...(card.type === 'interactive' ? { width: 560, height: 420 } : { width: 340, height: 320 }), ...layoutPatch(body, { width: card.type === 'interactive' ? 320 : 240, height: 240 }) };
      if (!existing && hasLayout(body) && !humanLayout) canvasLayout.assertAvailable(placement);
      cardPlacements.set(card.id, placement); broadcast(); return result(200, placement);
    }
    const placementMatch = path.match(/^\/api\/card-placements\/([^/]+)$/);
    if (placementMatch && ['PATCH', 'DELETE'].includes(method)) {
      const placement = cardPlacements.get(placementMatch[1]);
      if (!placement) return result(404, { error: 'Card placement not found' });
      if (method === 'DELETE') {
        cardPlacements.delete(placement.id); canvasLayout.forget('card', placement.id); broadcast(); return result(200, { ok: true });
      }
      const updates = {};
      for (const [key, value] of Object.entries(body)) {
        if (!validCardPlacementValue(placement.cardId, key, value)) throw new Error('Invalid placement dimensions');
        updates[key] = value;
      }
      if (hasLayout(body) && !humanLayout) canvasLayout.assertAvailable({ ...placement, ...updates }, { kind: 'card', id: placement.id });
      Object.assign(placement, updates); broadcast(); return result(200, placement);
    }
    if (path === '/api/agents' && method === 'POST') return result(201, createAgent(body, 'agents', humanLayout));
    const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/);
    if ((path === '/api/notes' && method === 'POST') || (noteMatch && ['PATCH', 'DELETE'].includes(method))) {
      const existing = noteMatch ? notes.get(noteMatch[1]) : null;
      if (noteMatch && !existing) return result(404, { error: 'Note not found' });
      if (method === 'DELETE') {
        notes.delete(existing.id); canvasLayout.forget('note', existing.id); broadcast(); return result(200, { ok: true });
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
      if (hasLayout(body) && !humanLayout) canvasLayout.assertAvailable(updated, existing ? { kind: 'note', id: existing.id } : undefined);
      notes.set(updated.id, updated); broadcast();
      return result(existing ? 200 : 201, updated);
    }
    if (path === '/api/edges' && method === 'POST') return result(201, connect(body.source, body.target, body.label));
    const edgeMatch = path.match(/^\/api\/edges\/([^/]+)$/);
    if (edgeMatch && method === 'PATCH') {
      const edge = edges.get(edgeMatch[1]);
      if (!edge) return result(404, { error: 'Edge not found' });
      edge.label = edgeLabel(body.label);
      broadcast(); return result(200, edge);
    }
    if (edgeMatch && method === 'DELETE') {
      if (!edges.delete(edgeMatch[1])) return result(404, { error: 'Edge not found' });
      broadcast(); return result(200, { ok: true });
    }
    const match = path.match(/^\/api\/agents\/([^/]+)(?:\/(stop|resume))?$/);
    if (match) {
      const agent = requireAgent(match[1]);
      if (match[2] === 'resume' && method === 'POST') {
        if (processes.has(agent.id)) return result(409, { error: 'Agent is already running' });
        try { startAgent(agent, true); }
        catch (error) { agent.status = 'stopped'; agent.restoreWarning = error.message; broadcast(); throw error; }
        return result(200, agent);
      }
      if (match[2] === 'stop' && method === 'POST') {
        return result(200, runtime.stop(agent.id));
      }
      if (!match[2] && method === 'DELETE') {
        if (agent.workspace === 'card-box') return result(409, { error: 'Card box agent is fixed; resume instead of removing it' });
        if (agent.status !== 'stopped' || processes.has(agent.id)) {
          throw Object.assign(new Error('Stop the agent before removing it'), { status: 409 });
        }
        agents.delete(agent.id); quietLayoutLaunches.delete(agent.id); runtime.forget(agent.id); canvasLayout.forget('agent', agent.id);
        for (const [id, edge] of edges) {
          if (edge.source === agent.id || edge.target === agent.id) edges.delete(id);
        }
        for (const ws of terminals.get(agent.id) || []) ws.terminate();
        terminals.delete(agent.id);
        broadcast();
        return result(200, { ok: true });
      }
      if (!match[2] && method === 'PATCH') {
        if (body.note !== undefined) throw new Error('Agent progress is SHM-only; use canvas_set_progress');
        const updates = {};
        if (body.name !== undefined) {
          if (!validText(body.name, 100)) throw new Error('name must be 1–100 characters');
          updates.name = body.name.trim();
        }
        for (const key of ['x', 'y', 'width', 'height']) {
          if (body[key] !== undefined) {
            if (!Number.isFinite(body[key]) || (key === 'width' && body[key] < 320) || (key === 'height' && body[key] < 240)) throw new Error(`Invalid ${key}`);
            updates[key] = body[key];
          }
        }
        if (hasLayout(body) && !humanLayout) {
          if (agent.workspace === 'card-box') throw Object.assign(new Error('Card box layout remains human-only'), { status: 403 });
          canvasLayout.assertAvailable({ ...agent, ...updates }, { kind: 'agent', id: agent.id });
        }
        Object.assign(agent, updates);
        broadcast(); return result(200, agent);
      }
    }
    return result(404, { error: 'Not found' });
  };
}
