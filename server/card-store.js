import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateCardLinks } from '../shared/card-links.js';
import { MEDIA, MEDIA_ID } from '../shared/card-media.js';
import { publicMediaFile, validateMediaFile } from './card-media-store.js';
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
      if (version > 4) throw new Error('Unsupported card database version');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
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
      if (version < 3) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const timestamp = this.now().toISOString();
          for (const row of this.db.prepare('SELECT id, links FROM cards').all()) {
            const links = validateCardLinks(JSON.parse(row.links));
            this.checkLinks(links, row.id, links);
            this.syncReciprocalLinks(row.id, links, [], timestamp);
          }
          this.db.exec('PRAGMA user_version=3; COMMIT;');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      if (version < 4) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS card_files (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
          mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS card_media (
          card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
          image_id TEXT REFERENCES card_files(id), audio_id TEXT REFERENCES card_files(id)
        );
        PRAGMA user_version=4;
        COMMIT;
      `);
    } catch (error) { this.db.close(); throw error; }
  }
  decode(row) {
    if (!row) throw Object.assign(new Error('Card not found'), { status: 404 });
    return { id: row.id, content: row.content, tags: JSON.parse(row.tags), links: validateCardLinks(JSON.parse(row.links)), units: inspectCardContent(row.content), ...this.cardMedia(row.id), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.db.prepare('SELECT * FROM cards ORDER BY substr(id,1,10) DESC, CAST(substr(id,12) AS INTEGER) DESC').all().map(row => this.decode(row)); }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM cards WHERE id=?').get(id)); }
  mediaFile(id) {
    const row = this.db.prepare('SELECT * FROM card_files WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Attachment not found'), { status: 404 });
    return validateMediaFile({ id: row.id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, filename: row.filename, createdAt: row.created_at });
  }
  cardMedia(id) {
    const row = this.db.prepare('SELECT image_id, audio_id FROM card_media WHERE card_id=?').get(id);
    return { image: row?.image_id ? publicMediaFile(this.mediaFile(row.image_id)) : null, audio: row?.audio_id ? publicMediaFile(this.mediaFile(row.audio_id)) : null };
  }
  assertMediaSlot(id, kind, expected) {
    if (!MEDIA[kind] || (expected !== null && (typeof expected !== 'string' || !MEDIA_ID.test(expected)))) throw new Error('Invalid attachment slot or expected ID');
    this.get(id);
    const current = this.db.prepare(`SELECT ${kind}_id AS id FROM card_media WHERE card_id=?`).get(id)?.id ?? null;
    if (current !== expected) throw Object.assign(new Error('Attachment changed; refresh and confirm replacement again'), { status: 409 });
  }
  setMedia(id, kind, file, expected = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertMediaSlot(id, kind, expected);
      const timestamp = this.now().toISOString();
      if (file) {
        validateMediaFile(file);
        if (file.kind !== kind) throw new Error('Attachment kind mismatch');
        this.db.prepare('INSERT INTO card_files (id,kind,name,mime,size,filename,created_at) VALUES (?,?,?,?,?,?,?)').run(file.id, file.kind, file.name, file.mime, file.size, file.filename, file.createdAt);
      }
      this.db.prepare(`INSERT INTO card_media (card_id,${kind}_id) VALUES (?,?) ON CONFLICT(card_id) DO UPDATE SET ${kind}_id=excluded.${kind}_id`).run(id, file?.id ?? null);
      this.db.prepare('UPDATE cards SET updated_at=? WHERE id=?').run(timestamp, id);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkLinks(links, selfId, previous = []) {
    const values = validateCardLinks(links);
    for (const id of values) {
      if (id === selfId) throw new Error('A card cannot link to itself');
      if (!previous.includes(id) && !this.db.prepare('SELECT id FROM cards WHERE id=?').get(id)) throw new Error(`Linked card not found: ${id}`);
    }
    return values;
  }
  // Call only within a transaction: either both endpoints change or neither does.
  syncReciprocalLinks(id, links, previous, timestamp) {
    const next = new Set(links);
    for (const targetId of new Set([...previous, ...links])) {
      const target = this.db.prepare('SELECT links FROM cards WHERE id=?').get(targetId);
      if (!target) continue; // Keep historical references to deleted cards.
      const existing = validateCardLinks(JSON.parse(target.links));
      const updated = next.has(targetId) ? [...new Set([...existing, id])] : existing.filter(link => link !== id);
      if (updated.length > 100) throw new Error(`Linked card ${targetId} would exceed 100 links`);
      if (JSON.stringify(updated) !== JSON.stringify(existing)) {
        this.db.prepare('UPDATE cards SET links=?, updated_at=? WHERE id=?').run(JSON.stringify(updated), timestamp, targetId);
      }
    }
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
      this.syncReciprocalLinks(id, links, [], timestamp);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  update(id, body) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const card = this.get(id);
      const content = body.content === undefined ? card.content : body.content;
      const tags = body.tags === undefined ? card.tags : validateTags(body.tags);
      const links = body.links === undefined ? card.links : this.checkLinks(body.links, id, card.links);
      validateCardContent(content);
      const timestamp = this.now().toISOString();
      this.db.prepare('UPDATE cards SET content=?, tags=?, links=?, updated_at=? WHERE id=?').run(content, JSON.stringify(tags), JSON.stringify(links), timestamp, id);
      this.syncReciprocalLinks(id, links, card.links, timestamp);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
