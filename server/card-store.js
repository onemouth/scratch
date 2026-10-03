import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateCardLinks } from '../shared/card-links.js';
import { inspectCardContent, validateCardContent } from '../shared/card-content.js';

export function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length > 30 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag.trim()].length > 60 || /[,\n\r]/.test(tag))) throw new Error('tags must be an array of up to 30 non-empty strings, each at most 60 characters, without commas/newlines');
  return [...new Set(tags.map(tag => tag.trim()))];
}
const localDay = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

export class CardStore {
  constructor(file = ':memory:', now = () => new Date()) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.file = file;
    this.now = now;
    this.db = new DatabaseSync(file);
    try {
      if (file !== ':memory:') chmodSync(file, 0o600);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2) throw new Error('Unsupported card database version');
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE cards (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE card_sequences (day TEXT PRIMARY KEY, number INTEGER NOT NULL);
        PRAGMA user_version=1;
        COMMIT;
      `);
      if (version < 2) this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE cards ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version=2;
        COMMIT;
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  decode(row) {
    if (!row) throw Object.assign(new Error('Card not found'), { status: 404 });
    return { id: row.id, content: row.content, tags: JSON.parse(row.tags), links: validateCardLinks(JSON.parse(row.links)), units: inspectCardContent(row.content), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.db.prepare('SELECT * FROM cards ORDER BY substr(id,1,10) DESC, CAST(substr(id,12) AS INTEGER) DESC').all().map(row => this.decode(row)); }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM cards WHERE id=?').get(id)); }
  checkLinks(links, selfId, previous = []) {
    const values = validateCardLinks(links);
    for (const id of values) {
      if (id === selfId) throw new Error('A card cannot link to itself');
      if (!previous.includes(id) && !this.db.prepare('SELECT id FROM cards WHERE id=?').get(id)) throw new Error(`Linked card not found: ${id}`);
    }
    return values;
  }
  create({ content = '', tags = [], links = [] } = {}) {
    validateCardContent(content); tags = validateTags(tags);
    links = this.checkLinks(links);
    const date = this.now(), day = localDay(date), timestamp = date.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { number } = this.db.prepare('INSERT INTO card_sequences(day,number) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET number=number+1 RETURNING number').get(day);
      const id = day + '-' + String(number).padStart(4, '0');
      this.db.prepare('INSERT INTO cards (id,content,tags,created_at,updated_at,links) VALUES (?,?,?,?,?,?)').run(id, content, JSON.stringify(tags), timestamp, timestamp, JSON.stringify(links));
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  update(id, body) {
    const card = this.get(id);
    const content = body.content === undefined ? card.content : body.content;
    const tags = body.tags === undefined ? card.tags : validateTags(body.tags);
    const links = body.links === undefined ? card.links : this.checkLinks(body.links, id, card.links);
    validateCardContent(content);
    this.db.prepare('UPDATE cards SET content=?, tags=?, links=?, updated_at=? WHERE id=?').run(content, JSON.stringify(tags), JSON.stringify(links), this.now().toISOString(), id);
    return this.get(id);
  }
  delete(id) { this.get(id); this.db.prepare('DELETE FROM cards WHERE id=?').run(id); }
  async backup() {
    if (this.file !== ':memory:') {
      await backup(this.db, this.file + '.bak');
      chmodSync(this.file + '.bak', 0o600);
    }
  }
  close() { this.db.close(); }
}
