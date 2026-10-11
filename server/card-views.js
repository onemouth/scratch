import { randomUUID } from 'node:crypto';
import { syncCardBoxPlacements } from './card-box-layout.js';

const cardId = /^\d{4}-\d{2}-\d{2}-\d{4,}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const key = name => name.normalize('NFKC').toLocaleLowerCase('en');
export function validateViewport(value) {
  if (value === null) return value;
  if (!value || Object.keys(value).some(k => !['x', 'y', 'zoom'].includes(k)) || !['x', 'y', 'zoom'].every(k => Number.isFinite(value[k])) || value.zoom < 0.2 || value.zoom > 2) fail('Invalid view viewport');
  return { x: value.x, y: value.y, zoom: value.zoom };
}
export function validateViewState(box) {
  if (!Array.isArray(box.views) || !box.views.length || typeof box.activeViewId !== 'string') fail('Invalid Card box views');
  if (box.revision !== undefined && (!Number.isSafeInteger(box.revision) || box.revision < 0)) fail('Invalid view revision');
  const ids = new Set(), names = new Set();
  let temporary = 0;
  for (const view of box.views) {
    if (!view || typeof view.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(view.id) || ids.has(view.id) || typeof view.saved !== 'boolean' || typeof view.name !== 'string' || view.name.length > 120 || view.name !== view.name.trim() || (view.saved && !view.name) || !Array.isArray(view.placements)) fail('Invalid Card box view');
    ids.add(view.id);
    if (view.name) { if (names.has(key(view.name))) fail('Duplicate view name'); names.add(key(view.name)); }
    if (!view.saved) { temporary++; if (view.id !== box.activeViewId) fail('Temporary view must be active'); }
    validateViewport(view.viewport);
    const members = new Set();
    for (const p of view.placements) {
      if (!p || p.id !== p.cardId || !cardId.test(p.id) || members.has(p.id) || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(p[k])) || p.width < 240 || p.height < 240) fail('Invalid view placement');
      members.add(p.id);
    }
  }
  if (!ids.has(box.activeViewId) || temporary > 1) fail('Invalid active view');
  return box;
}

// Contents remain authoritative in SQLite. Views/layouts live in Canvas JSON.
export class CardViews {
  constructor(box, cards) {
    this.views = new Map();
    this.epoch = randomUUID();
    this.revision = box?.revision ?? 0;
    if (box?.views) {
      validateViewState(box);
      for (const v of box.views) this.views.set(v.id, { ...v, placements: new Map(v.placements.map(p => [p.id, { ...p }])) });
      this.activeViewId = box.activeViewId;
      this.prune(cards);
    } else {
      const placements = new Map((box?.placements || []).map(p => [p.id, { ...p }]));
      syncCardBoxPlacements(placements, cards);
      const view = { id: randomUUID(), name: '原有 Card box', saved: true, viewport: null, placements };
      this.views.set(view.id, view); this.activeViewId = view.id;
    }
  }
  get active() { return this.get(this.activeViewId); }
  get(id) { const view = this.views.get(id); if (!view) fail('View not found', 404); return view; }
  snapshot({ live = true } = {}) {
    return { ...(live ? { epoch: this.epoch } : {}), revision: this.revision, activeViewId: this.activeViewId, placements: [...this.active.placements.values()], views: [...this.views.values()].map(v => ({ ...v, placements: [...v.placements.values()] })) };
  }
  name(value, id, required = true) {
    if (typeof value !== 'string' || value.length > 120 || (required && !value.trim())) fail('View name must contain 1–120 characters');
    const name = value.trim();
    if (name && [...this.views.values()].some(v => v.id !== id && key(v.name) === key(name))) fail('View name already exists', 409);
    return name;
  }
  // A stale tab cannot discard/save a different tab's new temporary view.
  departure(body) {
    if (body.fromViewId !== this.activeViewId) fail('Active view changed; refresh and try again', 409);
    if (this.active.saved) return () => {};
    if (!['save', 'discard'].includes(body.temporaryAction)) fail('Save or discard the temporary view before switching', 409);
    const source = this.active;
    const name = body.temporaryAction === 'save' ? this.name(body.saveName ?? source.name, source.id) : null;
    return () => { if (name !== null) { source.name = name; source.saved = true; } else this.views.delete(source.id); };
  }
  create(body, cards) {
    const name = this.name(body.name ?? '', null, false);
    const members = body.cardIds ?? [];
    if (!Array.isArray(members) || members.some(id => typeof id !== 'string' || !cards.some(c => c.id === id))) fail('cardIds must contain existing cards');
    const leave = this.departure(body);
    if (!this.active.saved && body.temporaryAction === 'save' && name && key(name) === key((body.saveName ?? this.active.name).trim())) fail('View name already exists', 409);
    const view = { id: randomUUID(), name, saved: false, viewport: null, placements: new Map() };
    syncCardBoxPlacements(view.placements, cards.filter(c => members.includes(c.id)));
    leave(); this.views.set(view.id, view); this.activeViewId = view.id;
    return view;
  }
  activate(id, body) {
    this.get(id);
    if (id === this.activeViewId) return;
    const leave = this.departure(body); leave(); this.activeViewId = id;
  }
  save(id, name) { const v = this.get(id); v.name = this.name(name ?? v.name, id); v.saved = true; }
  rename(id, name) { const v = this.get(id); v.name = this.name(name, id, v.saved); }
  remove(id, body) {
    const view = this.get(id);
    if (body.confirm !== true) fail('View deletion requires confirm: true');
    if (id === this.activeViewId && body.fromViewId !== id) fail('Active view changed; refresh and try again', 409);
    this.views.delete(id);
    if (id === this.activeViewId) {
      const next = [...this.views.values()].find(v => v.saved);
      if (next) this.activeViewId = next.id;
      else {
        const empty = { id: randomUUID(), name: '', saved: false, viewport: null, placements: new Map() };
        this.views.set(empty.id, empty); this.activeViewId = empty.id;
      }
    }
    return view;
  }
  add(id, card) {
    const view = this.get(id);
    syncCardBoxPlacements(view.placements, [...view.placements.keys()].map(id => ({ id })).concat(card));
  }
  prune(cards) {
    const ids = new Set(cards.map(c => c.id));
    for (const v of this.views.values()) for (const id of v.placements.keys()) if (!ids.has(id)) v.placements.delete(id);
  }
}
