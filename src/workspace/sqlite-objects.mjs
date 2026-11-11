// SPDX-License-Identifier: AGPL-3.0-only
import {sha256State} from '../kit/ledger/hash.mjs';

const MiB = 1024 * 1024;
export const SQLITE_OBJECT_LIMITS = Object.freeze({
  chunkBytes: 256 * 1024, objectBytes: 16 * MiB, metadataBytes: 16 * 1024,
  files: 4096, documents: 128, objects: 4096 + 128 * 3, listObjects: 128, readBytes: 16 * MiB, readers: 4, uploadMs: 30000,
  databaseBytes: (512 + 64 + 32) * MiB,
});
export const SQLITE_PROFILE = 'sqlite-notes-v1';
const encoder = new TextEncoder();
const error = (code, status = 503) => Object.assign(new Error(code), {code, status});
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && key.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(key);
const hashBytes = bytes => {const hash = sha256State(); hash.update(bytes); return hash.finish();};
const headerFields = 'key, generation, size, chunks, digest, metadata, uploaded';
const profileKey = 'body-store:profile';
const namesKey = 'body-store:names';
const parentOf = key => key.slice(0, key.lastIndexOf('/') + 1);
const addName = (folders, key) => {
  const parent = parentOf(key);
  if (!folders.has(parent)) folders.set(parent, new Set());
  folders.get(parent).add(key);
};

export class SQLiteObjects {
  constructor(storage, reserve) {
    if (!storage?.sql || !storage?.kv || typeof storage.transactionSync !== 'function' || typeof storage.sync !== 'function')
      throw error('workspace_storage_configuration');
    this.storage = storage; this.sql = storage.sql; this.reserve = reserve;
    this.readBytes = 0; this.readers = 0; this.observed = {rowsRead: 0, rowsWritten: 0}; this.ready = false;
    this.namesEpoch = crypto.randomUUID(); this.namesCatalog = null;
  }
  query(sql, ...bindings) {
    const cursor = this.sql.exec(sql, ...bindings), rows = Array.from(cursor);
    for (const key of ['rowsRead', 'rowsWritten']) if (integer(cursor[key], Number.MAX_SAFE_INTEGER)) this.observed[key] += cursor[key];
    return rows;
  }
  tableNames() {return this.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rapier_objects', 'rapier_chunks', 'rapier_object_state') ORDER BY name").map(row => row.name);}
  async initialize() {
    if (this.ready) return;
    await this.reserve(48, {inventory: true});
    const kv = this.storage.kv, tables = this.tableNames(), profile = kv.get(profileKey);
    if (!tables.length && profile === undefined) {
      const existing = Array.from(kv.list({limit: 8}));
      if (existing.some(([key]) => !['usage', 'notes:lease', 'notes:recording-leases'].includes(key))) throw error('workspace_accounting_unavailable');
      this.storage.transactionSync(() => {
        this.query('CREATE TABLE rapier_objects (key TEXT PRIMARY KEY, generation TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, digest TEXT NOT NULL, metadata TEXT NOT NULL, uploaded INTEGER NOT NULL)');
        this.query('CREATE TABLE rapier_chunks (key TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY (key, generation, ordinal)) WITHOUT ROWID');
        this.query('CREATE TABLE rapier_object_state (id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL, objects INTEGER NOT NULL)');
        this.query('INSERT INTO rapier_object_state VALUES (1, 0, 0)');
        kv.put(profileKey, SQLITE_PROFILE); kv.put('totals', {bytes: 0, files: 0, documents: 0}); kv.put('initialized', true);
      });
      await this.storage.sync();
    } else if (tables.length !== 3 || profile !== SQLITE_PROFILE) throw error('workspace_storage_configuration');
    const state = this.state(), totals = kv.get('totals');
    if (!totals || !integer(totals.files, SQLITE_OBJECT_LIMITS.files) || !integer(totals.documents, SQLITE_OBJECT_LIMITS.documents)) throw error('workspace_accounting_unavailable');
    await this.reserve(4 * (state.objects + totals.files + 3 * totals.documents + 4), {inventory: true});
    this.validateInventory(); this.ready = true;
  }
  validateInventory() {
    const kv = this.storage.kv, totals = kv.get('totals');
    if (kv.get('initialized') !== true || !totals || !integer(totals.bytes, 512 * MiB) || !integer(totals.files, SQLITE_OBJECT_LIMITS.files) || !integer(totals.documents, SQLITE_OBJECT_LIMITS.documents))
      throw error('workspace_accounting_unavailable');
    const state = this.state();
    const held = Array.from(kv.list({prefix: 'held:', limit: totals.documents + 1}));
    const documents = Array.from(kv.list({prefix: 'document:', limit: totals.documents + 1}));
    if (held.length > SQLITE_OBJECT_LIMITS.documents || documents.length !== totals.documents || documents.length > SQLITE_OBJECT_LIMITS.documents)
      throw error('workspace_accounting_unavailable');
    const required = new Set(), allowed = new Set(), absentOK = new Set(), pending = kv.get('pending');
    const add = (key, requiredHere = true) => {if (key) {allowed.add(key); if (requiredHere) required.add(key);}};
    let files = 0, after = '';
    for (;;) {
      const rows = Array.from(kv.list({prefix: 'file:', limit: Math.min(SQLITE_OBJECT_LIMITS.listObjects, totals.files - files + 1), ...(after ? {startAfter: after} : {})}));
      if (!rows.length) break;
      for (const [key, row] of rows) {
        if (++files > totals.files || key === after) throw error('workspace_accounting_unavailable');
        after = key;
        if (key !== 'file:' + row?.path || !validKey(row.path)) throw error('workspace_accounting_unavailable');
        add(row.path); add(row.snapshot); add(row.pendingSnapshot);
        const unresolved = row.pendingWrite || (row.address && kv.get('held:' + row.address)?.pendingWrite);
        if (row.etag === null && row.accountedBytes === 0 && unresolved?.beforeEtag === null && unresolved.path === row.path)
          absentOK.add(row.path);
        if (row.address && kv.get('document:' + row.address) !== row.path) throw error('workspace_accounting_unavailable');
      }
    }
    if (files !== totals.files) throw error('workspace_accounting_unavailable');
    for (const [key, value] of documents) if (kv.get('file:' + value)?.address !== key.slice(9)) throw error('workspace_accounting_unavailable');
    for (const [, row] of held) {add(row.key); if (row.discard) absentOK.add(row.key);}
    if (pending) {
      add(pending.path, false); add(pending.newSlot, false); add(pending.snapshot, false);
      add(pending.old?.snapshot, false); add(pending.next?.snapshot, false);
      if (pending.kind === 'delete') absentOK.add(pending.path);
    }
    const folders = new Map();
    let objects = 0, bytes = 0; after = '';
    for (;;) {
      const rows = this.query(`SELECT ${headerFields} FROM rapier_objects WHERE key > ? ORDER BY key LIMIT ?`,
        after, Math.min(SQLITE_OBJECT_LIMITS.listObjects, state.objects - objects + 1));
      if (!rows.length) break;
      for (const row of rows) {
        if (++objects > state.objects || !allowed.has(row.key)) throw error('workspace_accounting_unavailable');
        bytes += this.describe(row).size; required.delete(row.key); after = row.key; addName(folders, row.key);
      }
    }
    if (objects !== state.objects || bytes !== state.bytes || [...required].some(key => !absentOK.has(key))) throw error('workspace_accounting_unavailable');
    this.namesCatalog = {generation: this.namesGeneration(), folders};
  }
  namesGeneration() {return this.storage.kv.get(namesKey) || this.namesEpoch;}
  changedName(change) {
    if (!change) return;
    const catalog = this.namesCatalog;
    if (!catalog || catalog.generation !== change.before) {this.namesCatalog = null; return;}
    if (change.add) addName(catalog.folders, change.key);
    else {
      const parent = parentOf(change.key), names = catalog.folders.get(parent);
      names?.delete(change.key); if (!names?.size) catalog.folders.delete(parent);
    }
    catalog.generation = change.after;
  }
  async names({prefix, limit = SQLITE_OBJECT_LIMITS.listObjects, cursor} = {}) {
    this.assertReady();
    if (typeof prefix !== 'string' || !validKey(prefix) || !prefix.endsWith('/') ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > SQLITE_OBJECT_LIMITS.listObjects) throw error('invalid_cursor', 400);
    let token;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 4096) throw 0;
        token = JSON.parse(cursor);
        if (token.kind !== 'names' || token.prefix !== prefix || !validKey(token.after) || parentOf(token.after) !== prefix ||
            !/^[a-f0-9-]{36}$/.test(token.generation)) throw 0;
      } catch {throw error('invalid_cursor', 400);}
    }
    await this.reserve(8);
    const generation = this.namesGeneration();
    if (token && token.generation !== generation) throw error('file_changed', 412);
    if (this.namesCatalog?.generation !== generation) {
      const count = this.state().objects;
      await this.reserve(8 + 4 * (count + 1));
      if (this.namesGeneration() !== generation || this.state().objects !== count) throw error('file_changed', 412);
      const folders = new Map(); let found = 0, after = '';
      for (;;) {
        const rows = this.query('SELECT key FROM rapier_objects WHERE key > ? ORDER BY key LIMIT ?',
          after, Math.min(SQLITE_OBJECT_LIMITS.listObjects, count - found + 1));
        if (!rows.length) break;
        for (const row of rows) {
          if (++found > count || !validKey(row.key)) throw error('workspace_accounting_unavailable');
          addName(folders, row.key); after = row.key;
        }
      }
      if (found !== count) throw error('workspace_accounting_unavailable');
      this.namesCatalog = {generation, folders};
    }
    const keys = [...(this.namesCatalog.folders.get(prefix) || [])].sort().filter(key => !token || key > token.after);
    const selected = keys.slice(0, limit), truncated = keys.length > limit;
    return {names: selected, generation, truncated,
      ...(truncated ? {cursor: JSON.stringify({kind: 'names', prefix, generation, after: selected.at(-1)})} : {})};
  }
  state() {
    const rows = this.query('SELECT bytes, objects FROM rapier_object_state WHERE id = 1');
    if (rows.length !== 1 || !integer(rows[0].bytes, 512 * MiB + 32 * MiB) || !integer(rows[0].objects, SQLITE_OBJECT_LIMITS.objects)) throw error('workspace_accounting_unavailable');
    return rows[0];
  }
  assertReady() {if (!this.ready) throw error('workspace_storage_uninitialized');}
  databaseSize() {const value = this.sql.databaseSize; if (!integer(value, Number.MAX_SAFE_INTEGER)) throw error('workspace_accounting_unavailable'); return value;}
  capacity(bytes, objects = 1) {
    const physical = this.databaseSize(), state = this.state(), chunks = Math.ceil(bytes / SQLITE_OBJECT_LIMITS.chunkBytes);
    const growth = 2 * bytes + chunks * 8192 + objects * (SQLITE_OBJECT_LIMITS.metadataBytes + 16384) + 65536;
    if (state.bytes + bytes > 512 * MiB || state.objects + objects > SQLITE_OBJECT_LIMITS.objects || physical + growth > SQLITE_OBJECT_LIMITS.databaseBytes)
      throw error('workspace_storage_full', 507);
  }
  describe(row) {
    if (!row) return null;
    if (!validKey(row.key) || !/^[a-f0-9-]{36}$/.test(row.generation) || !integer(row.size, SQLITE_OBJECT_LIMITS.objectBytes) ||
        row.chunks !== Math.ceil(row.size / SQLITE_OBJECT_LIMITS.chunkBytes) || !/^[a-f0-9]{64}$/.test(row.digest) ||
        typeof row.metadata !== 'string' || encoder.encode(row.metadata).byteLength > SQLITE_OBJECT_LIMITS.metadataBytes || !integer(row.uploaded, Number.MAX_SAFE_INTEGER))
      throw error('workspace_object_corrupt');
    let metadata; try {metadata = JSON.parse(row.metadata);} catch {throw error('workspace_object_corrupt');}
    const record = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
    if (!metadata || Object.keys(metadata).sort().join(',') !== 'customMetadata,httpMetadata' ||
        !record(metadata.httpMetadata) || !record(metadata.customMetadata)) throw error('workspace_object_corrupt');
    return {key: row.key, size: row.size, etag: row.generation, httpEtag: '"' + row.generation + '"', uploaded: new Date(row.uploaded),
      httpMetadata: metadata.httpMetadata, customMetadata: metadata.customMetadata, writeHttpMetadata(headers) {for (const [field, header] of [['contentType', 'Content-Type'], ['contentLanguage', 'Content-Language'],
        ['contentDisposition', 'Content-Disposition'], ['contentEncoding', 'Content-Encoding'], ['cacheControl', 'Cache-Control']]) {
        if (metadata.httpMetadata[field] !== undefined) headers.set(header, metadata.httpMetadata[field]);
      }}};
  }
  header(key) {if (!validKey(key)) throw error('invalid_path', 400); return this.query(`SELECT ${headerFields} FROM rapier_objects WHERE key = ?`, key)[0] || null;}
  async head(key) {this.assertReady(); await this.reserve(4); return this.describe(this.header(key));}
  async get(key) {
    this.assertReady(); await this.reserve(4);
    const row = this.header(key), object = this.describe(row); if (!row) return null;
    await this.reserve(4 + 2 * row.chunks);
    if (this.header(key)?.generation !== row.generation) throw error('file_changed', 412);
    if (this.readers >= SQLITE_OBJECT_LIMITS.readers || this.readBytes + row.size > SQLITE_OBJECT_LIMITS.readBytes) throw error('workspace_read_busy', 503);
    this.readers++; this.readBytes += row.size;
    let chunks = [], released = false;
    const release = () => {if (!released) {released = true; chunks.length = 0; this.readers--; this.readBytes -= row.size;}};
    try {
      const rows = this.query('SELECT ordinal, body FROM rapier_chunks WHERE key = ? AND generation = ? ORDER BY ordinal LIMIT ?', key, row.generation, row.chunks + 1);
      if (rows.length !== row.chunks) throw error('workspace_object_corrupt');
      const hash = sha256State(); let size = 0;
      for (let i = 0; i < rows.length; i++) {
        const chunk = new Uint8Array(rows[i].body);
        if (rows[i].ordinal !== i || chunk.byteLength !== Math.min(SQLITE_OBJECT_LIMITS.chunkBytes, row.size - size)) throw error('workspace_object_corrupt');
        chunks.push(chunk); hash.update(chunk); size += chunk.byteLength;
      }
      if (size !== row.size || hash.finish() !== row.digest) throw error('workspace_object_corrupt');
      let at = 0;
      const body = new ReadableStream({pull(controller) {
        try {if (at === chunks.length) {release(); controller.close(); return;}
          const chunk = chunks[at]; chunks[at++] = null; controller.enqueue(chunk);
        } catch (cause) {release(); controller.error(cause);}
      }, cancel: release}, {highWaterMark: 0});
      return {...object, body, arrayBuffer: () => new Response(body).arrayBuffer(), text: () => new Response(body).text()};
    } catch (cause) {release(); throw cause;}
  }
  async put(key, input, options = {}) {
    this.assertReady(); if (!validKey(key)) throw error('invalid_path', 400);
    let bytes;
    if (typeof input === 'string') {if (input.length > SQLITE_OBJECT_LIMITS.objectBytes) throw error('upload_too_large', 413); bytes = encoder.encode(input);}
    else if (input instanceof Uint8Array) {if (input.byteLength > SQLITE_OBJECT_LIMITS.objectBytes) throw error('upload_too_large', 413); bytes = input.slice();}
    else if (input instanceof ArrayBuffer) {if (input.byteLength > SQLITE_OBJECT_LIMITS.objectBytes) throw error('upload_too_large', 413); bytes = new Uint8Array(input.slice(0));}
    else throw error('invalid_object_body', 400);
    if (bytes.byteLength > SQLITE_OBJECT_LIMITS.objectBytes) throw error('upload_too_large', 413);
    const metadata = JSON.stringify({httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {}});
    if (encoder.encode(metadata).byteLength > SQLITE_OBJECT_LIMITS.metadataBytes) throw error('invalid_object_metadata', 400);
    const condition = options.onlyIf;
    if (condition && !(Object.keys(condition).length === 1 && (condition.etagDoesNotMatch === '*' || typeof condition.etagMatches === 'string')))
      throw error('invalid_precondition', 400);
    const chunks = Math.ceil(bytes.byteLength / SQLITE_OBJECT_LIMITS.chunkBytes);
    let planned;
    try {
      await this.reserve(8); planned = this.header(key); this.describe(planned);
      if (condition?.etagDoesNotMatch === '*' && planned || condition?.etagMatches !== undefined && planned?.generation !== condition.etagMatches) return null;
      await this.reserve(24 + 4 * (chunks + (planned?.chunks || 0)) + (planned ? 0 : 8)); await options.beforeWrite?.();
    }
    catch (cause) {throw Object.assign(cause, {sqliteNotWritten: true});}
    let nameChange;
    const result = this.storage.transactionSync(() => {
      try {
      const old = this.header(key); this.describe(old);
      if (condition?.etagDoesNotMatch === '*' && old || condition?.etagMatches !== undefined && old?.generation !== condition.etagMatches) return null;
      if ((old?.generation || null) !== (planned?.generation || null)) throw error('file_changed', 412);
      this.capacity(bytes.byteLength, old ? 0 : 1);
      const generation = crypto.randomUUID(), digest = hashBytes(bytes), uploaded = Date.now();
      for (let ordinal = 0; ordinal < chunks; ordinal++) this.query('INSERT INTO rapier_chunks (key, generation, ordinal, body) VALUES (?, ?, ?, ?)',
        key, generation, ordinal, bytes.subarray(ordinal * SQLITE_OBJECT_LIMITS.chunkBytes, (ordinal + 1) * SQLITE_OBJECT_LIMITS.chunkBytes));
      this.query('INSERT INTO rapier_objects (key, generation, size, chunks, digest, metadata, uploaded) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,size=excluded.size,chunks=excluded.chunks,digest=excluded.digest,metadata=excluded.metadata,uploaded=excluded.uploaded',
        key, generation, bytes.byteLength, chunks, digest, metadata, uploaded);
      if (old) this.query('DELETE FROM rapier_chunks WHERE key = ? AND generation = ?', key, old.generation);
      this.query('UPDATE rapier_object_state SET bytes = bytes + ?, objects = objects + ? WHERE id = 1', bytes.byteLength - (old?.size || 0), old ? 0 : 1);
      if (!old) {
        nameChange = {key, add: true, before: this.namesGeneration(), after: crypto.randomUUID()};
        this.storage.kv.put(namesKey, nameChange.after);
      }
      return this.describe({key, generation, size: bytes.byteLength, chunks, digest, metadata, uploaded});
      } catch (cause) {throw Object.assign(cause, {sqliteNotWritten: true});}
    });
    this.changedName(nameChange);
    if (result) await this.storage.sync();
    return result;
  }
  async delete(key, {beforeWrite} = {}) {
    this.assertReady(); let planned;
    try {
      await this.reserve(8);
      planned = this.header(key); this.describe(planned); if (!planned) return;
      await this.reserve(24 + 4 * planned.chunks);
      await beforeWrite?.();
    } catch (cause) {throw Object.assign(cause, {sqliteNotWritten: true});}
    let nameChange;
    this.storage.transactionSync(() => {
      try {
      const old = this.header(key); this.describe(old); if (!old) return;
      if (old.generation !== planned.generation) throw error('file_changed', 412);
      this.query('DELETE FROM rapier_chunks WHERE key = ? AND generation = ?', key, old.generation);
      this.query('DELETE FROM rapier_objects WHERE key = ? AND generation = ?', key, old.generation);
      this.query('UPDATE rapier_object_state SET bytes = bytes - ?, objects = objects - 1 WHERE id = 1', old.size);
      nameChange = {key, add: false, before: this.namesGeneration(), after: crypto.randomUUID()};
      this.storage.kv.put(namesKey, nameChange.after);
      } catch (cause) {throw Object.assign(cause, {sqliteNotWritten: true});}
    });
    this.changedName(nameChange);
    await this.storage.sync();
  }
  async list({prefix = '', limit = 1000, cursor} = {}) {
    this.assertReady();
    if (typeof prefix !== 'string' || prefix.length > 1024 || !prefix.isWellFormed() || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw error('invalid_cursor', 400);
    let after = '';
    if (cursor !== undefined) {
      try {if (typeof cursor !== 'string' || cursor.length > 4096) throw 0;
        const token = JSON.parse(cursor); if (token.v !== 1 || token.prefix !== prefix || !validKey(token.after) || !token.after.startsWith(prefix)) throw 0; after = token.after;
      } catch {throw error('invalid_cursor', 400);}
    }
    limit = Math.min(limit, SQLITE_OBJECT_LIMITS.listObjects);
    await this.reserve(4);
    const count = Math.min(limit + 1, this.state().objects);
    await this.reserve(8 + 4 * count);
    if (Math.min(limit + 1, this.state().objects) > count) throw error('file_changed', 412);
    const points = [...prefix]; let end = null;
    while (points.length) {const last = points.pop().codePointAt(0); if (last < 0x10ffff) {
      const next = last + 1; end = points.join('') + String.fromCodePoint(next === 0xd800 ? 0xe000 : next); break;
    }}
    const rows = this.query(`SELECT ${headerFields} FROM rapier_objects WHERE key >= ? AND key > ?${end === null ? '' : ' AND key < ?'} ORDER BY key LIMIT ?`,
      ...[prefix, after, ...(end === null ? [] : [end]), limit + 1]);
    const truncated = rows.length > limit, selected = rows.slice(0, limit);
    return {objects: selected.map(row => this.describe(row)), truncated,
      ...(truncated ? {cursor: JSON.stringify({v: 1, prefix, after: selected.at(-1).key})} : {}), delimitedPrefixes: []};
  }
  usage() {
    const now = new Date().toISOString(), metric = (id, value, source, quality) => ({id, value, unit: 'bytes', scope: 'selected_vault', source, quality,
      availability: 'available', freshness: 'current', observedAt: now, fetchedAt: now, dataThrough: null, window: null});
    return {physical: {...metric('sqlite_bytes', this.databaseSize(), 'sqlite_database_size', 'exact'),
      limit: {value: SQLITE_OBJECT_LIMITS.databaseBytes, unit: 'bytes', scope: 'selected_vault', kind: 'application_policy', status: 'provisional'}},
      objects: metric('stored_object_bytes', this.state().bytes, 'rapier_metadata', 'exact'),
      instrumentation: {...this.observed, source: 'instrumented_sql', quality: 'partial', scope: 'selected_vault', since: 'object_activation'}};
  }
}
