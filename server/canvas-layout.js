export const LAYOUT_KEYS = ['x', 'y', 'width', 'height'];
export const hasLayout = body => LAYOUT_KEYS.some(key => Object.hasOwn(body, key));

export function layoutPatch(body, { width = 240, height = 240 } = {}) {
  const patch = {};
  for (const key of LAYOUT_KEYS) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (!Number.isFinite(value) || (key === 'width' && value < width) || (key === 'height' && value < height)) throw new Error(`Invalid ${key}`);
    patch[key] = value;
  }
  return patch;
}

export function rectanglesOverlap(a, b) {
  // Strict inequalities deliberately allow touching edges, with no padding.
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export class CanvasLayout {
  constructor(objects, { now = Date.now, leaseMs = 10000 } = {}) {
    this.objects = objects;
    this.now = now;
    this.leaseMs = leaseMs;
    this.leases = new Map();
  }
  key(kind, id) { return `${kind}:${id}`; }
  find(kind, id) {
    const object = this.objects().find(value => value.kind === kind && value.id === id);
    if (!object) throw Object.assign(new Error('Agent Canvas object not found'), { status: 404 });
    return object;
  }
  busy(kind, id) {
    const key = this.key(kind, id), owners = this.leases.get(key);
    if (!owners) return false;
    for (const [owner, expires] of owners) if (expires <= this.now()) owners.delete(owner);
    if (!owners.size) this.leases.delete(key);
    return owners.size > 0;
  }
  interaction(kind, id, owner, action) {
    this.find(kind, id);
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(owner) || !['start', 'renew', 'end'].includes(action)) throw new Error('Invalid layout interaction');
    const key = this.key(kind, id);
    this.busy(kind, id); // Prune expired owners before renewal/release.
    let owners = this.leases.get(key);
    if (action === 'end') {
      owners?.delete(owner);
      if (!owners?.size) this.leases.delete(key);
    } else {
      if (!owners) this.leases.set(key, owners = new Map());
      owners.set(owner, this.now() + this.leaseMs);
    }
    return { ok: true, leaseMs: this.leaseMs };
  }
  assertAvailable(rect, exclude) {
    if (!LAYOUT_KEYS.every(key => Number.isFinite(rect[key])) || !Number.isFinite(rect.x + rect.width) || !Number.isFinite(rect.y + rect.height)) throw new Error('Invalid layout rectangle');
    if (exclude && this.busy(exclude.kind, exclude.id)) throw Object.assign(new Error('A human is moving or resizing this object; retry later'), { status: 409, code: 'LAYOUT_BUSY', object: exclude });
    const conflicts = this.objects().filter(object => !(exclude && object.kind === exclude.kind && object.id === exclude.id) && rectanglesOverlap(rect, object));
    if (conflicts.length) throw Object.assign(new Error('Layout overlaps existing Agent Canvas objects'), { status: 409, code: 'LAYOUT_CONFLICT', conflicts });
  }
  snapshot() { return { objects: this.objects().map(object => ({ ...object, busy: this.busy(object.kind, object.id) })) }; }
  forget(kind, id) { this.leases.delete(this.key(kind, id)); }
  clear() { this.leases.clear(); }
}
