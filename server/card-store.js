import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateCardLinks } from '../shared/card-links.js';
import { MEDIA, MEDIA_ID } from '../shared/card-media.js';
import { publicMediaFile, validateMediaFile } from './card-media-store.js';
import { inspectCardContent, validateCardContent } from '../shared/card-content.js';
import { INTERACTIVE_LIMITS, validateInteractiveSource, validateInteractiveTitle } from './interactive-card.js';
import { validateInteractiveAssetFile } from './interactive-asset-store.js';
import { validateVaultKey, validateVaultValue, validateVaultConfig } from './vault-crypto.js';

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
      if (version > 8) throw new Error('Unsupported card database version');
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
      if (version < 5) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const columns = new Set(this.db.prepare('PRAGMA table_info(cards)').all().map(column => column.name));
          const additions = {
            type: "TEXT NOT NULL DEFAULT 'markdown'", title: "TEXT NOT NULL DEFAULT ''",
            interactive_html: "TEXT NOT NULL DEFAULT ''", interactive_css: "TEXT NOT NULL DEFAULT ''",
            interactive_javascript: "TEXT NOT NULL DEFAULT ''", interactive_revision: 'INTEGER NOT NULL DEFAULT 0',
          };
          for (const [name, declaration] of Object.entries(additions)) if (!columns.has(name)) this.db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${declaration}`);
          this.db.exec(`CREATE TABLE IF NOT EXISTS card_interactive_assets (
            id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
            filename TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE(card_id, name)
          ); PRAGMA user_version=5; COMMIT;`);
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      if (version < 6) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS vault_config (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS card_vault_values (card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
        PRAGMA user_version=6;
        COMMIT;
      `);
      if (version < 7) this.migrateVaultV6ToV8();
      else if (version < 8) this.migrateVaultV7ToV8();
      const vaultConfig = this.vaultConfig(); // Fail closed, never recreate lost crypto metadata.
      const vaultEntries = this.db.prepare('SELECT id FROM vault_entries LIMIT 1').get();
      const legacyVaultCard = this.db.prepare("SELECT id FROM cards WHERE type='vault' LIMIT 1").get();
      if (!vaultConfig && vaultEntries) throw new Error('Vault configuration is missing');
      if (legacyVaultCard) throw new Error('Legacy Vault card remains after migration');
    } catch (error) { this.db.close(); throw error; }
  }
  removeLegacyVaultLinks(ids) {
    const removed = new Set(ids), timestamp = this.now().toISOString();
    for (const row of this.db.prepare("SELECT id,links FROM cards WHERE type!='vault'").all()) {
      const links = validateCardLinks(JSON.parse(row.links)), next = links.filter(id => !removed.has(id));
      if (next.length !== links.length) this.db.prepare('UPDATE cards SET links=?,updated_at=? WHERE id=?').run(JSON.stringify(next), timestamp, row.id);
    }
  }
  migrateVaultV6ToV8() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      const config = this.vaultConfig(), oldCards = this.db.prepare("SELECT * FROM cards WHERE type='vault' ORDER BY id").all();
      const oldValues = this.db.prepare('SELECT card_id,envelope FROM card_vault_values').all();
      if (!config && (oldCards.length || oldValues.length)) throw new Error('Vault configuration is missing');
      const cardIds = new Set(oldCards.map(card => card.id));
      if (oldValues.some(row => !cardIds.has(row.card_id))) throw new Error('Vault encrypted value has no card');
      if (oldCards.length) {
        const valueById = new Map(oldValues.map(row => [row.card_id, row.envelope]));
        if (valueById.size !== oldCards.length) throw new Error('Vault encrypted value is missing');
        const keys = new Set();
        for (const card of oldCards) {
          const key = validateVaultKey(card.title);
          if (key !== card.title) throw new Error('Vault key metadata is not canonical; cannot preserve authenticated context');
          if (keys.has(key)) throw Object.assign(new Error(`Vault key already exists: ${key}`), { code: 'VAULT_KEY_EXISTS', status: 409 });
          keys.add(key); JSON.parse(valueById.get(card.id));
          this.db.prepare('INSERT INTO vault_entries (id,key,envelope,created_at,updated_at) VALUES (?,?,?,?,?)')
            .run(card.id, key, valueById.get(card.id), card.created_at, card.updated_at);
        }
        this.removeLegacyVaultLinks(oldCards.map(card => card.id));
        this.db.prepare("DELETE FROM cards WHERE type='vault'").run();
      }
      this.db.exec(`DROP TABLE IF EXISTS card_vault_values; DROP INDEX IF EXISTS cards_single_vault;
        PRAGMA user_version=8; COMMIT;`);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrateVaultV7ToV8() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const config = this.vaultConfig(), roots = this.db.prepare("SELECT id FROM cards WHERE type='vault'").all();
      const entries = this.db.prepare('SELECT id,key,envelope FROM vault_entries').all();
      if (!config && (roots.length || entries.length)) throw new Error('Vault configuration is missing');
      if (config && roots.length !== 1) throw new Error('Vault card is missing');
      for (const entry of entries) { if (validateVaultKey(entry.key) !== entry.key) throw new Error('Vault key metadata is not canonical'); JSON.parse(entry.envelope); }
      this.removeLegacyVaultLinks(roots.map(root => root.id));
      this.db.prepare("DELETE FROM cards WHERE type='vault'").run();
      this.db.exec('DROP INDEX IF EXISTS cards_single_vault; PRAGMA user_version=8; COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  decode(row, { includeInteractiveSource = true } = {}) {
    if (!row) throw Object.assign(new Error('Card not found'), { status: 404 });
    const common = { id: row.id, type: row.type, tags: JSON.parse(row.tags), links: validateCardLinks(JSON.parse(row.links)), createdAt: row.created_at, updatedAt: row.updated_at };
    if (row.type === 'interactive') return { ...common, title: row.title, interactive: { ...(includeInteractiveSource ? { html: row.interactive_html, css: row.interactive_css, javascript: row.interactive_javascript } : {}), revision: row.interactive_revision }, assets: this.interactiveAssets(row.id) };
    if (row.type !== 'markdown') throw new Error(`Unsupported card type: ${row.type}`);
    return { ...common, content: row.content, units: inspectCardContent(row.content), ...this.cardMedia(row.id) };
  }
  list(options) { return this.db.prepare('SELECT * FROM cards ORDER BY substr(id,1,10) DESC, CAST(substr(id,12) AS INTEGER) DESC').all().map(row => this.decode(row, options)); }
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
  interactiveAssets(id) {
    return this.db.prepare('SELECT * FROM card_interactive_assets WHERE card_id=? ORDER BY name').all(id).map(row => {
      const file = validateInteractiveAssetFile({ id: row.id, cardId: row.card_id, name: row.name, kind: row.kind, mime: row.mime, size: row.size, filename: row.filename, createdAt: row.created_at });
      const { filename, cardId, ...metadata } = file;
      return { ...metadata, url: '/api/interactive-assets/' + file.id };
    });
  }
  interactiveAssetFile(id) {
    const row = this.db.prepare('SELECT * FROM card_interactive_assets WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Interactive asset not found'), { status: 404 });
    return validateInteractiveAssetFile({ id: row.id, cardId: row.card_id, name: row.name, kind: row.kind, mime: row.mime, size: row.size, filename: row.filename, createdAt: row.created_at });
  }
  addInteractiveAsset(cardId, file) {
    validateInteractiveAssetFile(file);
    const card = this.get(cardId);
    if (card.type !== 'interactive') throw new Error('Interactive assets require an interactive card');
    const total = this.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM card_interactive_assets WHERE card_id=?').get(cardId).size;
    if (total + file.size > INTERACTIVE_LIMITS.totalAssetBytes) throw Object.assign(new Error('Interactive card assets exceed 100 MB'), { status: 413 });
    const timestamp = this.now().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO card_interactive_assets (id,card_id,name,kind,mime,size,filename,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(file.id, cardId, file.name, file.kind, file.mime, file.size, file.filename, file.createdAt);
      this.db.prepare('UPDATE cards SET interactive_revision=interactive_revision+1, updated_at=? WHERE id=?').run(timestamp, cardId);
      this.db.exec('COMMIT'); return this.get(cardId);
    } catch (error) { this.db.exec('ROLLBACK'); if (String(error.message).includes('UNIQUE constraint')) throw Object.assign(new Error(`Interactive asset name already exists: ${file.name}`), { status: 409 }); throw error; }
  }
  removeInteractiveAsset(cardId, name) {
    const card = this.get(cardId);
    if (card.type !== 'interactive') throw new Error('Interactive assets require an interactive card');
    const row = this.db.prepare('SELECT * FROM card_interactive_assets WHERE card_id=? AND name=?').get(cardId, name);
    if (!row) throw Object.assign(new Error('Interactive asset not found'), { status: 404 });
    const timestamp = this.now().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM card_interactive_assets WHERE id=?').run(row.id);
      this.db.prepare('UPDATE cards SET interactive_revision=interactive_revision+1, updated_at=? WHERE id=?').run(timestamp, cardId);
      this.db.exec('COMMIT'); return { card: this.get(cardId), file: { filename: row.filename } };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertMediaSlot(id, kind, expected) {
    if (!MEDIA[kind] || (expected !== null && (typeof expected !== 'string' || !MEDIA_ID.test(expected)))) throw new Error('Invalid attachment slot or expected ID');
    if (this.get(id).type !== 'markdown') throw new Error('Interactive cards use private interactive assets, not card attachment slots');
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
  vaultConfig() {
    const row = this.db.prepare('SELECT config FROM vault_config WHERE id=1').get();
    return row ? validateVaultConfig(JSON.parse(row.config)) : null;
  }
  initializeVault(config) {
    validateVaultConfig(config);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.vaultConfig()) throw Object.assign(new Error('Vault is already configured'), { code: 'VAULT_CONFIGURED', status: 409 });
      this.db.prepare('INSERT INTO vault_config (id,config) VALUES (1,?)').run(JSON.stringify(config));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  vaultEntries() {
    return this.db.prepare('SELECT id,key,created_at,updated_at FROM vault_entries ORDER BY created_at,id').all().map(row => ({ id: row.id, key: validateVaultKey(row.key), createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  vaultEntry(id) {
    const row = this.db.prepare('SELECT id,key,created_at,updated_at FROM vault_entries WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Vault entry not found'), { code: 'VAULT_ENTRY', status: 404 });
    return { id: row.id, key: validateVaultKey(row.key), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  vaultEntryByKey(key) {
    const normalized = validateVaultKey(key);
    const row = this.db.prepare('SELECT id,key,created_at,updated_at FROM vault_entries WHERE key=?').get(normalized);
    if (!row) throw Object.assign(new Error('Vault entry not found'), { code: 'VAULT_ENTRY', status: 404 });
    return { id: row.id, key: validateVaultKey(row.key), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  vaultEnvelope(id) {
    this.vaultEntry(id);
    const row = this.db.prepare('SELECT envelope FROM vault_entries WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('Vault encrypted value is missing'), { code: 'VAULT_AUTH', status: 400 });
    return JSON.parse(row.envelope);
  }
  createVaultEntry(body, { encryptVault } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['key', 'value'].includes(key)) || typeof encryptVault !== 'function') throw new Error('Invalid Vault entry creation');
    if (!this.vaultConfig()) throw Object.assign(new Error('Vault is not configured'), { code: 'VAULT_NOT_CONFIGURED', status: 409 });
    const key = validateVaultKey(body.key), value = validateVaultValue(body.value), id = randomUUID(), timestamp = this.now().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const envelope = encryptVault(id, key, value);
      this.db.prepare('INSERT INTO vault_entries (id,key,envelope,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, key, JSON.stringify(envelope), timestamp, timestamp);
      this.db.exec('COMMIT'); return this.vaultEntry(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE constraint')) throw Object.assign(new Error(`Vault key already exists: ${key}`), { code: 'VAULT_KEY_EXISTS', status: 409 });
      throw error;
    }
  }
  updateVaultEntry(id, body, { encryptVault, decryptVault } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['key', 'value'].includes(key)) || !Object.keys(body).length || typeof encryptVault !== 'function' || typeof decryptVault !== 'function') throw new Error('Invalid Vault entry update');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const entry = this.vaultEntry(id), key = body.key === undefined ? entry.key : validateVaultKey(body.key);
      if (key !== entry.key && this.db.prepare('SELECT id FROM vault_entries WHERE key=? AND id!=?').get(key, id)) throw Object.assign(new Error(`Vault key already exists: ${key}`), { code: 'VAULT_KEY_EXISTS', status: 409 });
      const value = body.value === undefined ? decryptVault(id, entry.key, this.vaultEnvelope(id)) : validateVaultValue(body.value);
      const envelope = encryptVault(id, key, value), timestamp = this.now().toISOString();
      this.db.prepare('UPDATE vault_entries SET key=?,envelope=?,updated_at=? WHERE id=?').run(key, JSON.stringify(envelope), timestamp, id);
      this.db.exec('COMMIT'); return this.vaultEntry(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteVaultEntry(id) {
    this.vaultEntry(id);
    this.db.prepare('DELETE FROM vault_entries WHERE id=?').run(id);
    return { ok: true };
  }
  resetVault() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM vault_entries; DELETE FROM vault_config;');
      this.db.exec('COMMIT'); return [];
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Card creation requires an object');
    const type = body.type ?? 'markdown';
    if (!['markdown', 'interactive'].includes(type)) throw new Error('type must be markdown or interactive');
    const allowed = type === 'interactive' ? ['type', 'title', 'html', 'css', 'javascript', 'tags', 'links'] : ['type', 'content', 'tags', 'links'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error(`Invalid ${type} card creation fields`);
    let { content = '', title, html, css, javascript, tags = [], links = [] } = body;
    let source;
    if (type === 'interactive') { title = validateInteractiveTitle(title); source = validateInteractiveSource({ html, css, javascript }); content = ''; }
    else validateCardContent(content);
    tags = validateTags(tags);
    links = this.checkLinks(links);
    const date = this.now(), day = localDay(date), timestamp = date.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { number } = this.db.prepare('INSERT INTO card_sequences(day,number) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET number=number+1 RETURNING number').get(day);
      const id = day + '-' + String(number).padStart(4, '0');
      this.db.prepare('INSERT INTO cards (id,content,tags,created_at,updated_at,links,type,title,interactive_html,interactive_css,interactive_javascript) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, content, JSON.stringify(tags), timestamp, timestamp, JSON.stringify(links), type, title ?? '', source?.html ?? '', source?.css ?? '', source?.javascript ?? '');
      this.syncReciprocalLinks(id, links, [], timestamp);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  update(id, body) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const card = this.get(id);
      const allowed = card.type === 'interactive' ? ['title', 'html', 'css', 'javascript', 'tags', 'links'] : ['content', 'tags', 'links'];
      if (!body || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) throw new Error(`Invalid ${card.type} card update fields`);
      const tags = body.tags === undefined ? card.tags : validateTags(body.tags);
      const links = body.links === undefined ? card.links : this.checkLinks(body.links, id, card.links);
      const timestamp = this.now().toISOString();
      if (card.type === 'interactive') {
        const title = body.title === undefined ? card.title : validateInteractiveTitle(body.title);
        const source = validateInteractiveSource({
          html: body.html === undefined ? card.interactive.html : body.html,
          css: body.css === undefined ? card.interactive.css : body.css,
          javascript: body.javascript === undefined ? card.interactive.javascript : body.javascript,
        });
        const sourceChanged = ['html', 'css', 'javascript'].some(key => body[key] !== undefined);
        this.db.prepare(`UPDATE cards SET title=?, interactive_html=?, interactive_css=?, interactive_javascript=?,
          interactive_revision=interactive_revision+?, tags=?, links=?, updated_at=? WHERE id=?`)
          .run(title, source.html, source.css, source.javascript, sourceChanged ? 1 : 0, JSON.stringify(tags), JSON.stringify(links), timestamp, id);
      } else {
        const content = body.content === undefined ? card.content : body.content;
        validateCardContent(content);
        this.db.prepare('UPDATE cards SET content=?, tags=?, links=?, updated_at=? WHERE id=?').run(content, JSON.stringify(tags), JSON.stringify(links), timestamp, id);
      }
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
