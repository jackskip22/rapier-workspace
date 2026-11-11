// SPDX-License-Identifier: AGPL-3.0-only
import {sha256, sha256State} from '../kit/ledger/hash.mjs';
import {isNoteFile} from '../notes/model.mjs';
import {recordingStem} from '../notes/recording-files.mjs';
import {SQLiteObjects, SQLITE_PROFILE, SQLITE_OBJECT_LIMITS} from './sqlite-objects.mjs';

export const WORKSPACE_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024, sourceBytes: 2 * 1024 * 1024, recoveryBytes: 8 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024, files: 4096, documents: 128,
  requestsPerDay: 12000, writesPerDay: 4000, storageUnitsPerDay: 60000,
  recoveryRequestsPerDay: 12000, recoveryWritesPerDay: 1024, recoveryUnitsPerDay: 240000,
});
const DAY = 86400000;
const RECORDING_SCOPE = 'rapier-notes-recording:notes:', RECORDING_LEASES = 'notes:recording-leases';
const MAX_RECORDING_LEASES = 32;
const utf8 = new TextEncoder(), decode = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const json = (value, status = 200, headers = {}) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', ...headers}});
const fail = (code, status = 409) => Object.assign(new Error(code), {code, status});
const recordKey = path => 'file:' + path;
const documentKey = id => 'document:' + id;
const SLOTS = ['a', 'b', 'c'];
const slotKey = (id, slot, commit = null) => '.rapier/documents/' + id + '/' + slot + (commit ? '-' + commit : '') + '.json';
const candidateKey = (address, pending) => {
  const next = pending?.next;
  return SLOTS.includes(next?.slot) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pending.commit || '') &&
    (next.snapshot === slotKey(address, next.slot, pending.commit) || next.snapshot === slotKey(address, next.slot));
};
const heldKey = id => 'held:' + id;
const etagOf = object => object?.etag || null;
const summary = row => ({path: row.path, bytes: row.bytes, etag: row.etag,
  ...(row.address ? {address: row.address, revision: row.revision, recovery: row.snapshot, conflict: row.conflict === true,
    editor_url: '/d/ws_' + btoa(String.fromCharCode(...row.address.match(/../g).map(pair => parseInt(pair, 16))))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')} : {})});

export function workspacePath(value) {
  if (typeof value !== 'string' || value.length > 1024) throw fail('invalid_path', 400);
  const parts = value.split('/');
  const metadata = parts[0] === '.rapier' && parts[1] === 'notes' && parts.length >= 3 && parts.length <= 32;
  if ((!metadata && (!['notes', 'documents'].includes(parts[0]) || !(parts.length === 2 || parts.length === 3 && ['attachments', 'audio'].includes(parts[1])))) ||
      parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part)) ||
      [...parts.at(-1)].length > 255) throw fail('invalid_path', 400);
  if (!metadata && parts.length === 2 && !isNoteFile(parts[1])) throw fail('note_filename_required', 400);
  return value;
}

export async function boundedBytes(request, limit, timeoutMs = 0) {
  const advertised = request.headers.get('Content-Length');
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) throw fail('upload_too_large', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); let bytes = new Uint8Array(Math.min(limit, 65536)), size = 0, timer, stopped, reads = 0;
  const stop = error => {stopped ||= error; void reader.cancel(stopped).catch(() => {});};
  const abort = () => stop(fail('upload_canceled', 408));
  if (timeoutMs) timer = setTimeout(() => stop(fail('upload_timed_out', 408)), timeoutMs);
  request.signal?.addEventListener('abort', abort, {once: true});
  if (request.signal?.aborted) abort();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (stopped) throw stopped;
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > limit) throw fail('upload_too_large', 413);
      if (size + value.byteLength > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(limit, Math.max(size + value.byteLength, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, size)); bytes = grown;
      }
      bytes.set(value, size); size += value.byteLength;
      if (timeoutMs && ++reads % 64 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {void reader.cancel(error).catch(() => {}); throw error;}
  finally {clearTimeout(timer); request.signal?.removeEventListener('abort', abort); reader.releaseLock();}
  return bytes.subarray(0, size);
}

export class WorkspaceFilesOwner {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.pending = Promise.resolve();
    this.profile = env.WORKSPACE_BODY_STORE || 'r2'; this.sqlObjects = null; this.recoveryAllowance = false; this.restoreReads = false;
  }
  get objects() {
    if (this.profile === SQLITE_PROFILE) return this.sqlObjects ||= new SQLiteObjects(this.ctx.storage,
      (units, {inventory = false} = {}) => this.charge({requests: 0, units, recoveryFirst: inventory}));
    if (this.profile !== 'r2' || this.kv.get('body-store:profile') !== undefined || !this.env.BUCKET) throw fail('workspace_storage_configuration', 503);
    return this.env.BUCKET;
  }
  readInput(request, limit) {return boundedBytes(request, limit, this.profile === SQLITE_PROFILE ? SQLITE_OBJECT_LIMITS.uploadMs : 0);}
  get kv() {return this.ctx.storage.kv;}
  exclusive(fn) {const work = this.pending.then(fn); this.pending = work.catch(() => {}); return work;}
  totals() {
    const value = this.kv.get('totals');
    if (!value && this.profile === SQLITE_PROFILE) throw fail('workspace_accounting_unavailable', 503);
    return value || {bytes: 0, files: 0, documents: 0};
  }
  async flush() {await this.ctx.storage.sync();}

  async access(request) {
    let access;
    try {access = JSON.parse(request.headers.get('X-Rapier-Access'));} catch {}
    if (!access || !await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    return access;
  }

  async notesLease(request, action) {
    let access;
    try {access = JSON.parse(request.headers.get('X-Rapier-Access'));} catch {}
    if (!access || !['browser', 'agent'].includes(access.kind) || !await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    if (!action) {
      const current = this.kv.get('notes:lease'), now = Date.now();
      const id = request.headers.get('X-Rapier-Notes-Lease');
      if (!current || current.id !== id || current.principal !== access.principalId || current.expiresAt <= now)
        throw fail('notes_lease_required', 423);
      return current;
    }
    const input = JSON.parse(decode.decode(await this.readInput(request, 4096)));
    const stem = typeof input?.name === 'string' && input.name.startsWith(RECORDING_SCOPE) ? input.name.slice(RECORDING_SCOPE.length) : null;
    if (!plain(input) || !(input.name === 'rapier-notes:notes' || stem && recordingStem(stem + '.json') === stem) || !/^[a-f0-9-]{36}$/.test(input.id || '') ||
        !['acquire', 'renew', 'release'].includes(input.action)) throw fail('invalid_lease', 400);
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const now = Date.now(), records = stem ? Object.fromEntries(Object.entries(this.kv.get(RECORDING_LEASES) || {})
      .filter(([, lease]) => lease.expiresAt > now)) : null;
    const current = stem ? records[stem] : this.kv.get('notes:lease');
    const keep = async lease => {
      this.ctx.storage.transactionSync(() => {
        if (stem) {
          if (lease) records[stem] = lease; else delete records[stem];
          if (Object.keys(records).length) this.kv.put(RECORDING_LEASES, records); else this.kv.delete(RECORDING_LEASES);
        } else if (lease) this.kv.put('notes:lease', lease); else this.kv.delete('notes:lease');
      });
      await this.flush();
    };
    const same = current?.id === input.id && current.principal === access.principalId;
    if (input.action === 'release') {
      if (same) await keep(null);
      return json({released: same});
    }
    await this.charge({units: 4});
    if (current && current.expiresAt > now && !same || input.action === 'renew' && (!same || current.expiresAt <= now))
      return json({acquired: false}, 423);
    if (stem && !current && Object.keys(records).length >= MAX_RECORDING_LEASES) return json({acquired: false}, 423);
    const lease = {id: input.id, principal: access.principalId, expiresAt: Math.min(now + 30000, access.expiresAt)};
    await keep(lease);
    return json({acquired: true, expiresAt: lease.expiresAt});
  }

  async recordingLease(request, path) {
    const id = request.headers.get('X-Rapier-Recording-Lease');
    const stem = path?.startsWith('.rapier/notes/') ? recordingStem(path.slice('.rapier/notes/'.length)) : null;
    const current = stem && this.kv.get(RECORDING_LEASES)?.[stem], now = Date.now();
    const mutating = !['GET', 'HEAD'].includes(request.method);
    if (!id && !(mutating && current?.expiresAt > now)) return;
    const access = await this.access(request);
    if (!current || current.id !== id || current.principal !== access.principalId || current.expiresAt <= now)
      throw fail('notes_lease_required', 423);
  }

  async charge({requests = 1, writes = 0, units = 0, recoveryFirst = false} = {}) {
    recoveryFirst ||= this.restoreReads;
    const day = Math.floor(Date.now() / DAY), previous = this.kv.get('usage');
    const usage = previous?.day === day ? {...previous} : {day, requests: 0, writes: 0, units: 0};
    const recovery = {...(usage.recovery || {requests: 0, writes: 0, units: 0})};
    const recoveryFits = this.recoveryAllowance && recovery.requests + requests <= WORKSPACE_LIMITS.recoveryRequestsPerDay &&
      recovery.writes + writes <= WORKSPACE_LIMITS.recoveryWritesPerDay && recovery.units + units <= WORKSPACE_LIMITS.recoveryUnitsPerDay;
    if (!(recoveryFirst && recoveryFits) &&
        usage.requests + requests <= WORKSPACE_LIMITS.requestsPerDay && usage.writes + writes <= WORKSPACE_LIMITS.writesPerDay &&
        usage.units + units <= WORKSPACE_LIMITS.storageUnitsPerDay) {
      usage.requests += requests; usage.writes += writes; usage.units += units;
    } else {
      if (!recoveryFits) throw fail('workspace_allowance_reached', 429);
      recovery.requests += requests; recovery.writes += writes; recovery.units += units;
      usage.recovery = recovery;
    }
    this.ctx.storage.transactionSync(() => this.kv.put('usage', usage));
    await this.flush();
  }

  async initialize() {
    if (this.profile === SQLITE_PROFILE) return this.objects.initialize();
    this.objects;
    if (this.kv.get('initialized')) return;
    let cursor, bytes = 0, files = 0, objects = 0;
    const inventory = [];
    do {
      await this.charge({requests: 0, writes: 1, units: 1});
      const page = await this.objects.list({limit: 1000, ...(cursor ? {cursor} : {})});
      for (const object of page.objects) {
        bytes += object.size; objects++;
        if (object.key.startsWith('notes/') || object.key.startsWith('documents/') || object.key.startsWith('.rapier/notes/')) {
          files++;
          inventory.push({path: object.key, bytes: object.size, accountedBytes: object.size, etag: object.etag,
            type: object.httpMetadata?.contentType || 'application/octet-stream'});
        }
        if (bytes > WORKSPACE_LIMITS.totalBytes || files > WORKSPACE_LIMITS.files || objects > WORKSPACE_LIMITS.files + WORKSPACE_LIMITS.documents * 3)
          throw fail('bucket_allowance_reached', 507);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await this.charge({requests: 0, units: inventory.length + 3});
    this.ctx.storage.transactionSync(() => {
      for (const row of inventory) this.kv.put(recordKey(row.path), row);
      this.kv.put('totals', {bytes, files, documents: 0}); this.kv.put('initialized', true);
    });
    await this.flush();
  }

  plainPending(row) {
    const pending = row?.pendingWrite, next = pending?.next;
    return row?.conflict && !row.address && !next?.address &&
      pending?.path === row.path && next?.path === row.path && !pending.newSlot &&
      /^[a-f0-9]{64}$/.test(next.sourceHash || '') && Number.isSafeInteger(next.bytes) && next.bytes >= 0 ? pending : null;
  }

  async plainBytes(object, next) {
    if (!object?.body || object.size !== next.bytes || !/^[a-f0-9]{64}$/.test(next.sourceHash || '')) return false;
    const reader = object.body.getReader(), hash = sha256State(); let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        size += value.byteLength; if (size > next.bytes) return false; hash.update(value);
      }
      return size === next.bytes && hash.finish() === next.sourceHash;
    } finally {reader.releaseLock();}
  }

  async plainReceipt(pending, check = async () => {}) {
    const next = pending.next;
    if (!/^[a-f0-9]{64}$/.test(next.sourceHash || '')) return null;
    const object = await this.objects.get(pending.path);
    try {
      await check();
      if (!object?.body || object.size !== next.bytes || object.customMetadata?.rapierCommit !== pending.commit ||
          object.httpMetadata?.contentType !== next.type) return null;
      if (!await this.plainBytes(object, next)) return null;
      const current = await this.objects.head(pending.path); await check();
      return current?.etag === object.etag && current.customMetadata?.rapierCommit === pending.commit &&
        current.httpMetadata?.contentType === next.type && (!object.version || current.version === object.version) ? object : null;
    } finally {await object?.body?.cancel().catch(() => {});}
  }

  plainAccounting(row) {
    return {path: row.path, bytes: row.bytes, accountedBytes: row.accountedBytes, etag: row.etag, type: row.type};
  }

  plainCurrent(row, pending) {
    if (this.plainPending(this.kv.get(recordKey(row.path)))?.commit !== pending.commit)
      throw fail('outside_change_needs_recovery');
  }

  async settlePlain(row, check) {
    const pending = this.plainPending(row);
    if (!pending) return null;
    const object = await this.plainReceipt(pending, check);
    this.plainCurrent(row, pending);
    if (!object) return null;
    await this.charge({requests: 0, units: 8}); await check();
    this.plainCurrent(row, pending);
    return this.finish({...pending.next, etag: object.etag}, {...pending, old: this.plainAccounting(row)});
  }

  async replayPlain(row, {bytes, type, match, create, check}) {
    const pending = this.plainPending(row), hash = sha256State(); hash.update(bytes);
    if (!pending || pending.next.bytes !== bytes.byteLength || pending.next.sourceHash !== hash.finish() ||
        pending.next.type !== type || (pending.beforeEtag === null ? !create : create || match !== pending.beforeEtag))
      throw fail('outside_change_needs_recovery');
    const settled = await this.settlePlain(row, check);
    if (settled) return settled;
    if (!(this.objects instanceof SQLiteObjects)) throw fail('outside_change_needs_recovery');
    const object = await this.objects.head(row.path); await check();
    this.plainCurrent(row, pending);
    if (etagOf(object) !== pending.beforeEtag) throw fail('outside_change_needs_recovery');
    if (this.totals().bytes + bytes.byteLength > WORKSPACE_LIMITS.totalBytes) throw fail('workspace_storage_full', 507);
    this.objects.capacity(bytes.byteLength, object ? 0 : 1);
    await this.charge({requests: 0, writes: 1, units: 12});
    this.plainCurrent(row, pending);
    const retry = {...pending, old: this.plainAccounting(row)};
    this.ctx.storage.transactionSync(() => this.kv.put('pending', retry)); await this.flush();
    await check();
    this.plainCurrent(row, pending);
    await this.objects.put(row.path, bytes, {beforeWrite: async () => {await check(); this.plainCurrent(row, pending);},
      onlyIf: pending.beforeEtag === null ? {etagDoesNotMatch: '*'} : {etagMatches: pending.beforeEtag},
      httpMetadata: {contentType: type}, customMetadata: {rapierCommit: pending.commit}});
    const verified = await this.plainReceipt(retry, check);
    this.plainCurrent(row, pending);
    if (!verified) throw fail('outside_change_needs_recovery');
    return this.finish({...pending.next, etag: verified.etag}, retry);
  }

  async recoverPending() {
    const pending = this.kv.get('pending');
    if (!pending) return;
    if (pending.phase === 'abandoned') return this.abandon(pending);
    let object = await this.objects.head(pending.path);
    const currentSave = () => {
      if (this.objects instanceof SQLiteObjects && !pending.kind &&
          (this.kv.get('pending')?.commit !== pending.commit ||
           etagOf(object) !== pending.beforeEtag && object?.customMetadata?.rapierCommit !== pending.commit))
        throw fail('outside_change_needs_recovery');
    };
    currentSave();
    if (pending.kind === 'delete') {
      if (!object) return this.finishDelete(pending);
      this.ctx.storage.transactionSync(() => this.kv.delete('pending'));
      await this.flush();
      await this.account(pending.path, object);
      return;
    }
    if (object?.customMetadata?.rapierCommit === pending.commit) {
      let verified = !pending.next.address && object.size === pending.next.bytes;
      if (!pending.next.address) {
        const receipt = await this.plainReceipt(pending);
        verified = !!receipt; if (receipt) object = receipt;
      }
      if (pending.next.address) {
        object = await this.objects.get(pending.path);
        if (object?.body && object.customMetadata?.rapierCommit === pending.commit && object.size === pending.next.bytes &&
            object.customMetadata.rapierSnapshotHash === pending.next.snapshotHash) {
          const bytes = await boundedBytes({headers: new Headers(), body: object.body}, WORKSPACE_LIMITS.sourceBytes);
          const hash = sha256State(); hash.update(bytes);
          verified = bytes.byteLength === pending.next.bytes && hash.finish() === pending.next.sourceHash;
        } else await object?.body?.cancel();
      }
      currentSave();
      if (verified) return this.finish({...pending.next, etag: object.etag}, pending);
    }
    if (this.objects instanceof SQLiteObjects && !pending.next.address &&
        etagOf(object) === pending.beforeEtag && object?.customMetadata?.rapierCommit !== pending.commit)
      return this.abandon(pending);
    const current = this.kv.get(recordKey(pending.path)), address = pending.next.address;
    const held = address && this.kv.get(heldKey(address));
    const candidate = pending.newSlot && await this.objects.head(pending.newSlot);
    const observedBytes = object?.size || 0, candidateBytes = candidate?.size || 0;
    currentSave();
    const sourceChanged = etagOf(object) !== pending.beforeEtag;
    const row = {...(current || {path: pending.path, bytes: 0, etag: null, type: pending.next.type}),
      ...(address ? {address} : {}), accountedBytes: observedBytes};
    if (!address || held) Object.assign(row, {conflict: true, pendingWrite: pending,
      pendingSnapshot: pending.newSlot || null, pendingSnapshotBytes: candidateBytes});
    else if (sourceChanged) row.conflict = true;
    const totals = this.totals();
    totals.bytes += observedBytes - (current?.accountedBytes ?? current?.bytes ?? 0) + candidateBytes;
    if (!current) totals.files++;
    if (address && !current?.address) totals.documents++;
    this.ctx.storage.transactionSync(() => {
      this.kv.put(recordKey(pending.path), row);
      if (address) {
        this.kv.put(documentKey(address), pending.path);
        if (!held) this.kv.put(heldKey(address), {key: pending.newSlot, bytes: candidateBytes, pendingWrite: pending});
      }
      this.kv.put('totals', totals); this.kv.delete('pending');
    });
    await this.flush();
  }

  async finish(row, pending) {
    const old = pending.old, totals = this.totals();
    totals.bytes += row.bytes + (row.snapshotBytes || 0) - (old?.accountedBytes ?? old?.bytes ?? 0) - (old?.snapshotBytes || 0);
    if (!old) totals.files++;
    if (row.address && !old?.address) totals.documents++;
    row = {...row, accountedBytes: row.bytes};
    this.ctx.storage.transactionSync(() => {
      this.kv.put(recordKey(row.path), row);
      if (row.address) this.kv.put(documentKey(row.address), row.path);
      this.kv.put('totals', totals);
      this.kv.put('pending', {...pending, committed: true, next: row});
    });
    await this.flush();
    if (old?.snapshot && old.snapshot !== row.snapshot) await this.objects.delete(old.snapshot);
    this.ctx.storage.transactionSync(() => this.kv.delete('pending'));
    await this.flush();
    return row;
  }

  async account(path, object) {
    const old = this.kv.get(recordKey(path));
    if (!object || old && (old.accountedBytes ?? old.bytes) === object.size) return old;
    const totals = this.totals();
    totals.bytes += object.size - (old?.accountedBytes ?? old?.bytes ?? 0);
    if (!old) totals.files++;
    const row = old ? {...old, accountedBytes: object.size} : {path, bytes: object.size, accountedBytes: object.size,
      etag: object.etag, type: object.httpMetadata?.contentType || 'application/octet-stream'};
    this.ctx.storage.transactionSync(() => {this.kv.put(recordKey(path), row); this.kv.put('totals', totals);});
    await this.flush(); return row;
  }

  async abandon(pending) {
    if (pending.phase !== 'abandoned') {
      pending = {...pending, phase: 'abandoned'};
      this.ctx.storage.transactionSync(() => this.kv.put('pending', pending));
      await this.flush();
    }
    if (pending.newSlot) await this.objects.delete(pending.newSlot);
    this.ctx.storage.transactionSync(() => this.kv.delete('pending'));
    await this.flush();
  }

  async finishDelete(pending) {
    const old = pending.old, totals = this.totals();
    if (old) {totals.bytes -= old.accountedBytes ?? old.bytes; totals.files--;}
    this.ctx.storage.transactionSync(() => {
      this.kv.delete(recordKey(pending.path)); this.kv.put('totals', totals); this.kv.delete('pending');
    });
    await this.flush();
  }

  async settle(reserved = false) {
    const pending = this.kv.get('pending');
    if (!pending) return;
    if (!reserved) await this.charge({requests: 0, writes: 1, units: 12});
    if (this.objects instanceof SQLiteObjects && !pending.kind && this.kv.get('pending')?.commit !== pending.commit)
      throw fail('outside_change_needs_recovery');
    if (pending?.kind === 'retire') {
      if (pending.snapshot) await this.objects.delete(pending.snapshot);
      this.ctx.storage.transactionSync(() => this.kv.delete('pending'));
      await this.flush();
    } else if (pending?.committed) {
      if (pending.old?.snapshot && pending.old.snapshot !== pending.next.snapshot) await this.objects.delete(pending.old.snapshot);
      this.ctx.storage.transactionSync(() => this.kv.delete('pending'));
      await this.flush();
    } else await this.recoverPending();
  }

  async replace({path, bytes, type, match, create = false, recovery = null, address = null, revision = null, check = async () => {}}) {
    path = workspacePath(path);
    if (bytes.byteLength > (path.split('/').length === 2 ? WORKSPACE_LIMITS.sourceBytes : WORKSPACE_LIMITS.fileBytes)) throw fail('upload_too_large', 413);
    let old = this.kv.get(recordKey(path));
    if (old?.conflict) {
      if (!address && !old.address)
        return this.replayPlain(old, {bytes, type, match, create, check});
      throw fail(old.pendingWrite && address && this.kv.get(heldKey(address)) ?
        'held_candidate_needs_resolution' : 'outside_change_needs_recovery');
    }
    if (old?.address && old.address !== address) throw fail('document_is_open');
    const object = await this.objects.head(path), beforeEtag = etagOf(object);
    await check();
    if (create ? beforeEtag !== null : typeof match !== 'string' || beforeEtag !== match) throw fail('file_changed', 412);
    old = await this.account(path, object) || old;
    const snapshotText = recovery === null ? null : JSON.stringify(recovery), snapshotBytes = snapshotText === null ? 0 : utf8.encode(snapshotText).byteLength;
    if (snapshotBytes > WORKSPACE_LIMITS.recoveryBytes) throw fail('history_allowance_reached', 507);
    const totals = this.totals(), reservedBytes = bytes.byteLength + snapshotBytes;
    if (totals.bytes + reservedBytes > WORKSPACE_LIMITS.totalBytes || totals.files > WORKSPACE_LIMITS.files ||
        !old && totals.files >= WORKSPACE_LIMITS.files ||
        address && !old?.address && totals.documents >= WORKSPACE_LIMITS.documents) throw fail('workspace_storage_full', 507);
    if (this.profile === SQLITE_PROFILE) this.objects.capacity(reservedBytes, (old ? 0 : 1) + (address ? 1 : 0));
    const held = address && this.kv.get(heldKey(address));
    if (address && (old?.snapshot && !SLOTS.includes(old.slot) || held && (!candidateKey(address, held.pendingWrite) ||
        held.key !== held.pendingWrite.newSlot || held.key !== held.pendingWrite.next.snapshot))) throw fail('held_candidate_changed');
    const commit = crypto.randomUUID(), slot = SLOTS.find(slot => slot !== old?.slot && slot !== held?.pendingWrite.next.slot);
    if (address && !slot) throw fail('held_candidate_needs_resolution');
    const snapshot = address ? slotKey(address, slot, commit) : null;
    const plainHash = !address ? sha256State() : null;
    plainHash?.update(bytes);
    const next = {path, bytes: bytes.byteLength, type, ...(plainHash ? {sourceHash: plainHash.finish()} : {}),
      ...(address ? {address, revision, slot, snapshot,
        snapshotBytes, sourceHash: sha256(decode.decode(bytes)), snapshotHash: sha256(snapshotText)} : {})};
    const pending = {path, commit, beforeEtag, old, newSlot: snapshot,
      reservedBytes, next};
    await this.charge({requests: 0, writes: snapshot ? 3 : 1, units: 12 + Math.ceil((snapshotBytes + (old?.snapshotBytes || 0)) / 8192)});
    this.ctx.storage.transactionSync(() => this.kv.put('pending', pending));
    await this.flush();
    if (snapshot && !await this.objects.put(snapshot, snapshotText, {
      ...(this.profile === SQLITE_PROFILE ? {onlyIf: {etagDoesNotMatch: '*'}} : {}),
      httpMetadata: {contentType: 'application/json'},
      customMetadata: {rapierDocument: address, rapierSnapshotHash: next.snapshotHash}})) throw fail('held_candidate_changed');
    try {await check();}
    catch (error) {
      await this.abandon(pending); throw error;
    }
    let stored;
    try {stored = await this.objects.put(path, bytes, {
      ...(this.profile === SQLITE_PROFILE ? {beforeWrite: check} : {}),
      onlyIf: create ? {etagDoesNotMatch: '*'} : {etagMatches: match}, httpMetadata: {contentType: type},
      customMetadata: {rapierCommit: commit, ...(address ? {rapierDocument: address, rapierSnapshot: snapshot,
        rapierSnapshotHash: next.snapshotHash, rapierSourceHash: next.sourceHash} : {})},
    });
    } catch (error) {
      if (this.profile === SQLITE_PROFILE && error.sqliteNotWritten === true) await this.abandon(pending);
      throw error;
    }
    if (!stored) {
      await this.abandon(pending); throw fail('file_changed', 412);
    }
    return this.finish({...next, etag: stored.etag}, pending);
  }

  async commit(custody, access = null) {
    if (!plain(custody) || !plain(custody.head) || !plain(custody.state) || !Array.isArray(custody.journal) ||
        typeof custody.state.text !== 'string' || custody.head.documentId !== custody.state.documentId ||
        !/^[a-f0-9]{64}$/.test(custody.address || '')) throw fail('invalid_recovery', 400);
    const address = custody.address, knownPath = this.kv.get(documentKey(address));
    const path = knownPath || workspacePath('documents/' + custody.state.filename);
    if (knownPath && custody.state.filename !== path.slice('documents/'.length)) throw fail('rename_needs_file_owner');
    const old = this.kv.get(recordKey(path)), bytes = utf8.encode(custody.state.text);
    if (old?.conflict) throw fail(old.pendingWrite && this.kv.get(heldKey(address)) ?
      'held_candidate_needs_resolution' : 'outside_change_needs_recovery');
    if (old?.address && old.address !== address) throw fail('filename_exists');
    if (old && Number.isSafeInteger(old.revision) && custody.state.revision < old.revision) throw fail('recovery_moved');
    const snapshotHash = sha256(JSON.stringify(custody));
    if (old?.snapshotHash === snapshotHash) {
      const current = await this.objects.head(path);
      if (current?.etag !== old.etag) throw fail('file_changed', 412);
      return summary(old);
    }
    const grants = access === null ? [] : Array.isArray(access) ? access : [access];
    const check = async () => {for (const grant of grants) if (!grant || !await this.env.accessCurrent(grant) ||
      custody.head.ownerKey !== sha256(grant.ownerId)) throw fail('sign_in_required', 401);};
    await check();
    let condition = old?.etag ? {match: old.etag} : {create: true};
    if (!old?.address) {
      const existing = await this.objects.get(path);
      if (existing) {
        if (existing.size !== bytes.byteLength || existing.size > WORKSPACE_LIMITS.sourceBytes) {
          await existing.body?.cancel(); throw fail('filename_exists');
        }
        const actual = new Uint8Array(await existing.arrayBuffer());
        if (actual.some((byte, at) => byte !== bytes[at])) throw fail('filename_exists');
        condition = {match: existing.etag};
      }
    }
    return summary(await this.replace({path, bytes, type: 'text/markdown; charset=utf-8', address, check,
      revision: custody.state.revision, recovery: custody, ...condition}));
  }

  async recovery(address) {
    const path = this.kv.get(documentKey(address));
    if (!path) return null;
    const row = this.kv.get(recordKey(path)), object = await this.objects.head(path);
    if (!row?.snapshot || row.conflict || object?.etag !== row.etag ||
        object.customMetadata?.rapierSnapshotHash !== row.snapshotHash) throw fail('file_changed', 412);
    const kept = await this.objects.get(row.snapshot);
    if (!kept || kept.size > WORKSPACE_LIMITS.recoveryBytes) {await kept?.body?.cancel(); throw fail('recovery_unavailable', 503);}
    const text = await kept.text();
    if (sha256(text) !== row.snapshotHash) throw fail('recovery_unavailable', 503);
    const custody = JSON.parse(text);
    if (custody.address !== address || sha256(custody.state.text) !== row.sourceHash) throw fail('recovery_unavailable', 503);
    return custody;
  }

  heldCandidate(address) {
    if (!/^[a-f0-9]{64}$/.test(address || '')) throw fail('invalid_recovery', 400);
    const held = this.kv.get(heldKey(address));
    if (!held) throw fail('held_candidate_missing', 404);
    const path = this.kv.get(documentKey(address)), row = path && this.kv.get(recordKey(path)), next = held.pendingWrite?.next;
    if (!row || row.address !== address || held.pendingWrite?.path !== path || next?.address !== address ||
        !candidateKey(address, held.pendingWrite) || held.key !== held.pendingWrite.newSlot ||
        held.key !== next.snapshot || held.key === row.snapshot || held.key === row.pendingSnapshot ||
        !/^[a-f0-9]{64}$/.test(next.snapshotHash || '') || !Number.isSafeInteger(held.bytes) || held.bytes < 1 ||
        held.bytes !== next.snapshotBytes || held.bytes > WORKSPACE_LIMITS.recoveryBytes) throw fail('held_candidate_changed');
    return held;
  }

  async heldBytes(address, held, access, allowMissing = false) {
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const hash = held.pendingWrite.next.snapshotHash, object = await this.objects.get(held.key);
    try {if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);}
    catch (error) {await object?.body?.cancel(); throw error;}
    if (!object && allowMissing) return null;
    if (!object?.body || object.size !== held.bytes || object.size > WORKSPACE_LIMITS.recoveryBytes ||
        object.customMetadata?.rapierDocument !== address || object.customMetadata?.rapierSnapshotHash !== hash) {
      await object?.body?.cancel(); throw fail('held_candidate_unavailable', 503);
    }
    const bytes = await boundedBytes({headers: new Headers(), body: object.body}, WORKSPACE_LIMITS.recoveryBytes);
    const actual = sha256State(); actual.update(bytes);
    if (bytes.byteLength !== held.bytes || actual.finish() !== hash) throw fail('held_candidate_unavailable', 503);
    const custody = JSON.parse(decode.decode(bytes));
    if (custody?.address !== address || custody.head?.ownerKey !== sha256(access.ownerId)) throw fail('sign_in_required', 401);
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    return bytes;
  }

  async heldDownload(address, access) {
    const held = this.heldCandidate(address), bytes = await this.heldBytes(address, held, access);
    return new Response(bytes, {headers: {'Content-Type': 'application/json', 'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="held-recovery.json"',
      'X-Rapier-Held-Key': held.key, 'X-Rapier-Held-Hash': held.pendingWrite.next.snapshotHash}});
  }

  async selectedSource(row, access) {
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const object = await this.objects.get(row.path);
    try {if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);}
    catch (error) {await object?.body?.cancel(); throw error;}
    if (!object) return {bytes: 0, matches: !row.snapshot && row.etag === null};
    const observed = {bytes: object.size, matches: false};
    if (!object.body || !row.snapshot || object.size !== row.bytes || object.size > WORKSPACE_LIMITS.sourceBytes ||
        object.etag !== row.etag || object.customMetadata?.rapierDocument !== row.address ||
        object.customMetadata?.rapierSnapshot !== row.snapshot || object.customMetadata?.rapierSnapshotHash !== row.snapshotHash ||
        object.customMetadata?.rapierSourceHash !== row.sourceHash) {await object.body?.cancel(); return observed;}
    const bytes = await boundedBytes({headers: new Headers(), body: object.body}, WORKSPACE_LIMITS.sourceBytes);
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    if (bytes.byteLength !== object.size) throw fail('held_discard_unavailable', 503);
    const hash = sha256State(); hash.update(bytes); observed.matches = hash.finish() === row.sourceHash;
    return observed;
  }

  async finishHeldDiscard(input, access) {
    const held = this.heldCandidate(input.address), path = held.pendingWrite.path;
    if (held.key !== input.key || held.pendingWrite.next.snapshotHash !== input.hash) throw fail('held_candidate_changed');
    const old = this.kv.get(recordKey(path)); let row = old, promoted = null;
    if (old.pendingWrite) {
      const pending = old.pendingWrite, next = pending.next, key = old.pendingSnapshot;
      if (!next || pending.path !== path || next.address !== input.address || key !== pending.newSlot || key !== next.snapshot ||
          key === held.key || key === old.snapshot || !candidateKey(input.address, pending) ||
          !/^[a-f0-9]{64}$/.test(next.snapshotHash || '') || !Number.isSafeInteger(old.pendingSnapshotBytes) ||
          old.pendingSnapshotBytes < 1 || old.pendingSnapshotBytes !== next.snapshotBytes || old.pendingSnapshotBytes > WORKSPACE_LIMITS.recoveryBytes)
        throw fail('held_discard_unavailable', 503);
      promoted = {key, bytes: old.pendingSnapshotBytes, pendingWrite: pending};
      const source = await this.selectedSource(old, access);
      row = {...old, accountedBytes: source.bytes, conflict: !source.matches};
      delete row.pendingWrite; delete row.pendingSnapshot; delete row.pendingSnapshotBytes;
    }
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const current = this.heldCandidate(input.address);
    if (current.key !== input.key || current.pendingWrite.next.snapshotHash !== input.hash ||
        current.discard?.ownerKey !== sha256(access.ownerId)) throw fail('held_candidate_changed');
    const totals = this.totals();
    totals.bytes += (row.accountedBytes ?? row.bytes) - (old.accountedBytes ?? old.bytes) - held.bytes;
    if (!Number.isSafeInteger(totals.bytes) || totals.bytes < 0) throw fail('workspace_accounting_unavailable', 503);
    this.ctx.storage.transactionSync(() => {
      if (promoted) {this.kv.put(recordKey(path), row); this.kv.put(heldKey(input.address), promoted);}
      else this.kv.delete(heldKey(input.address));
      this.kv.put('totals', totals);
    });
    await this.flush();
    const uncertain = !!(this.kv.get('pending') || row.pendingWrite || row.pendingSnapshot);
    return {discarded: {key: input.key, hash: input.hash},
      held: promoted ? {key: promoted.key, hash: promoted.pendingWrite.next.snapshotHash} : null,
      conflict: row.conflict === true, pending: uncertain, writable: !promoted && !row.conflict && !uncertain};
  }

  async heldDiscard(input, access) {
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    if (!plain(input) || typeof input.address !== 'string' || !/^[a-f0-9]{64}$/.test(input.address) ||
        typeof input.key !== 'string' || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) throw fail('invalid_recovery', 400);
    let held = this.heldCandidate(input.address);
    if (held.key !== input.key || held.pendingWrite.next.snapshotHash !== input.hash) throw fail('held_candidate_changed');
    const intent = {key: input.key, hash: input.hash, ownerKey: sha256(access.ownerId)};
    if (held.discard && (held.discard.key !== input.key || held.discard.hash !== input.hash)) throw fail('held_candidate_changed');
    if (held.discard && held.discard.ownerKey !== intent.ownerKey) throw fail('sign_in_required', 401);
    await this.charge({requests: 0, writes: 1, units: 20});
    const bytes = await this.heldBytes(input.address, held, access, !!held.discard);
    if (bytes !== null) {
      if (!held.discard) {
        held = {...held, discard: intent};
        this.ctx.storage.transactionSync(() => this.kv.put(heldKey(input.address), held)); await this.flush();
      }
      if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
      const current = this.heldCandidate(input.address);
      if (current.key !== input.key || current.pendingWrite.next.snapshotHash !== input.hash ||
          current.discard?.ownerKey !== intent.ownerKey) throw fail('held_candidate_changed');
      await this.objects.delete(input.key, this.profile === SQLITE_PROFILE ? {beforeWrite: async () => {
        if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
        const current = this.heldCandidate(input.address);
        if (current.key !== input.key || current.pendingWrite.next.snapshotHash !== input.hash ||
            current.discard?.ownerKey !== intent.ownerKey) throw fail('held_candidate_changed');
      }} : undefined);
      if (await this.objects.head(input.key)) throw fail('held_discard_unavailable', 503);
    }
    return this.finishHeldDiscard(input, access);
  }

  async retire({address, access}) {
    if (!/^[a-f0-9]{64}$/.test(address || '')) throw fail('invalid_recovery', 400);
    const path = this.kv.get(documentKey(address));
    if (!path) return {retired: true};
    if (!access || !await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const old = this.kv.get(recordKey(path));
    if (old?.address !== address) throw fail('recovery_moved');
    if (old.conflict || this.kv.get(heldKey(address))) throw fail('held_candidate_needs_resolution');
    if (this.totals().documents < 1) throw fail('workspace_accounting_unavailable', 503);
    await this.charge({requests: 0, writes: old.snapshot ? 1 : 0, units: 6});
    if (!await this.env.accessCurrent(access)) throw fail('sign_in_required', 401);
    const row = {path, bytes: old.bytes, accountedBytes: old.accountedBytes ?? old.bytes, etag: old.etag, type: old.type};
    const totals = this.totals(); totals.documents--; totals.bytes -= old.snapshotBytes || 0;
    this.ctx.storage.transactionSync(() => {
      this.kv.put(recordKey(path), row); this.kv.delete(documentKey(address)); this.kv.put('totals', totals);
      this.kv.put('pending', {kind: 'retire', snapshot: old.snapshot || null});
    });
    await this.flush(); await this.settle(true);
    return {retired: true};
  }

  fetch(request) {return this.exclusive(async () => {
    try {
      const url = new URL(request.url);
      this.recoveryAllowance = ['GET', 'HEAD'].includes(request.method) && ['/files', '/recovery', '/held'].includes(url.pathname) ||
        request.method === 'POST' && ['/lease', '/held/discard', '/retire'].includes(url.pathname) ||
        request.method === 'DELETE' && url.pathname === '/files' && url.searchParams.get('path')?.startsWith('.rapier/notes/');
      if (url.pathname === '/lease' && request.method === 'POST') return await this.notesLease(request, true);
      if (this.profile === SQLITE_PROFILE && !['/files', '/admit'].includes(url.pathname)) return json({error: 'method'}, 405);
      const discardRoute = url.pathname === '/held/discard', heldRoute = url.pathname === '/held' || discardRoute;
      const access = heldRoute || url.pathname === '/files' ? await this.access(request) : null;
      if (heldRoute && (typeof access.ownerId !== 'string' || !access.ownerId)) throw fail('sign_in_required', 401);
      if (url.pathname === '/files' && ['GET', 'HEAD'].includes(request.method) && request.headers.get('X-Rapier-Notes-Recovery') === 'restore') {
        await this.notesLease(request);
        this.restoreReads = !!this.kv.get(recordKey('.rapier/notes/.rapier-owner.json'));
      }
      await this.charge({units: heldRoute ? 8 : 4});
      if (discardRoute) {
        if (request.method !== 'POST') return json({error: 'method'}, 405, {Allow: 'POST'});
        const bytes = await this.readInput(request, 4096);
        let input; try {input = JSON.parse(decode.decode(bytes));} catch {throw fail('invalid_recovery', 400);}
        return json(await this.heldDiscard(input, access));
      }
      if (heldRoute) return request.method === 'GET' ? await this.heldDownload(url.searchParams.get('address'), access) :
        json({error: 'method'}, 405, {Allow: 'GET'});
      if (url.pathname === '/admit' && request.method === 'POST') return json({ok: true});
      await this.initialize(); await this.settle();
      if (url.pathname === '/commit' && request.method === 'POST') {
        const bytes = await this.readInput(request, WORKSPACE_LIMITS.recoveryBytes);
        const input = JSON.parse(decode.decode(bytes));
        return json(await this.commit(input.custody || input, input.access || null));
      }
      if (url.pathname === '/retire' && request.method === 'POST') {
        const bytes = await this.readInput(request, 32768);
        return json(await this.retire(JSON.parse(decode.decode(bytes))));
      }
      if (url.pathname === '/recovery' && request.method === 'GET') {
        const value = await this.recovery(url.searchParams.get('address')); return value ? json(value) : json({error: 'missing'}, 404);
      }
      if (url.pathname !== '/files') return json({error: 'missing'}, 404);
      const path = url.searchParams.get('path');
      const privateFile = path?.startsWith('.rapier/notes/') || url.searchParams.get('prefix')?.startsWith('.rapier/notes/');
      const check = async () => {
        await this.access(request);
        if (privateFile && !['GET', 'HEAD'].includes(request.method) || request.headers.has('X-Rapier-Notes-Lease')) await this.notesLease(request);
        await this.recordingLease(request, path);
        const held = this.kv.get('notes:lease');
        if (!['GET', 'HEAD'].includes(request.method) && held?.expiresAt > Date.now() && request.headers.get('X-Rapier-Notes-Lease') !== held.id)
          throw fail('notes_lease_required', 423);
      };
      await check();
      if (!path) {
        if (request.method !== 'GET') return json({error: 'method'}, 405);
        const prefix = url.searchParams.get('prefix') || 'notes/';
        if (!(prefix === 'notes/' || prefix === 'documents/' || prefix === '.rapier/notes/' ||
            /^(?:notes|documents)\/(?:attachments|audio)\//.test(prefix) || prefix.startsWith('.rapier/notes/')) ||
            /(?:^|\/)\.\.(?:\/|$)|[\\\u0000-\u001f]/.test(prefix))
          throw fail('invalid_path', 400);
        const cursor = url.searchParams.get('cursor');
        if (cursor && cursor.length > 4096) throw fail('invalid_cursor', 400);
        await this.charge({requests: 0, writes: 1, units: 1});
        if (url.searchParams.get('names') === '1' && this.profile === SQLITE_PROFILE) {
          const listed = await this.objects.names({prefix, ...(cursor ? {cursor} : {})});
          await check();
          if (this.objects.namesGeneration() !== listed.generation) throw fail('file_changed', 412);
          return json({names: listed.names, complete: !listed.truncated, ...(listed.truncated ? {cursor: listed.cursor} : {}),
            allowance: WORKSPACE_LIMITS, used: this.totals(), storage: this.objects.usage()});
        }
        const listed = await this.objects.list({prefix, limit: 1000, ...(cursor ? {cursor} : {})});
        await check();
        return json({files: listed.objects.map(object => {
          const row = this.kv.get(recordKey(object.key));
          return {...(row ? summary(row) : {path: object.key}), bytes: object.size, etag: object.etag,
            ...(row?.etag && row.etag !== object.etag ? {conflict: true} : {})};
        }), complete: !listed.truncated, ...(listed.truncated ? {cursor: listed.cursor} : {}), allowance: WORKSPACE_LIMITS, used: this.totals(),
          ...(this.profile === SQLITE_PROFILE ? {storage: this.objects.usage()} : {})});
      }
      workspacePath(path);
      if (['GET', 'HEAD'].includes(request.method)) {
        const row = this.kv.get(recordKey(path)); let expected;
        if (!row?.address && row?.conflict && row.pendingWrite) {
          const pending = this.plainPending(row);
          if (!pending) throw fail('outside_change_needs_recovery');
          const settled = await this.settlePlain(row, check);
          expected = settled?.etag ?? pending.beforeEtag;
          if (!settled) {
            const proof = await this.objects.get(path);
            try {
              await check();
              if (etagOf(proof) !== pending.beforeEtag || await this.plainBytes(proof, pending.next))
                throw fail('outside_change_needs_recovery');
            } finally {await proof?.body?.cancel().catch(() => {});}
          }
        }
        const object = await this.objects[request.method === 'HEAD' ? 'head' : 'get'](path);
        if (!object) {
          if (expected !== undefined && expected !== null) throw fail('outside_change_needs_recovery');
          return json({error: 'missing'}, 404);
        }
        try {
          await check();
          if (expected !== undefined && object.etag !== expected) throw fail('outside_change_needs_recovery');
          if (request.headers.has('If-Match') && request.headers.get('If-Match') !== object.httpEtag) throw fail('file_changed', 412);
          const headers = new Headers({'ETag': object.httpEtag, 'Content-Length': String(object.size), 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment'});
          object.writeHttpMetadata(headers);
          if (this.profile === SQLITE_PROFILE) {
            headers.set('Cache-Control', 'no-store, no-transform');
            if (request.method !== 'HEAD') {
              const stream = new FixedLengthStream(object.size), response = new Response(stream.readable, {headers});
              const settled = object.body.pipeTo(stream.writable).catch(() => {});
              const body = response.body, cancel = body.cancel.bind(body), getReader = body.getReader.bind(body);
              body.cancel = async reason => {await cancel(reason); await settled;};
              body.getReader = options => {
                const reader = getReader(options), cancel = reader.cancel.bind(reader);
                reader.cancel = async reason => {await cancel(reason); await settled;};
                return reader;
              };
              return response;
            }
          }
          return new Response(request.method === 'HEAD' ? null : object.body, {headers});
        } catch (error) {await object.body?.cancel(); throw error;}
      }
      if (request.method === 'PUT') {
        const bytes = await this.readInput(request, path.split('/').length === 2 ? WORKSPACE_LIMITS.sourceBytes : WORKSPACE_LIMITS.fileBytes);
        if (path.split('/').length === 2) decode.decode(bytes);
        const matchHeader = request.headers.get('If-Match'), create = request.headers.get('If-None-Match') === '*';
        if (!create && !/^"[^"\r\n]+"$/.test(matchHeader || '')) return json({error: 'precondition_required'}, 428);
        const row = await this.replace({path, bytes, type: path.endsWith('.md') ? 'text/markdown; charset=utf-8' :
          request.headers.get('Content-Type') || 'application/octet-stream', create, match: matchHeader?.slice(1, -1), check});
        return json(summary(row), 200, {ETag: '"' + row.etag + '"'});
      }
      if (request.method === 'DELETE' && privateFile) {
        const object = await this.objects.head(path);
        if (!object) return new Response(null, {status: 204});
        if (request.headers.get('If-Match') !== object.httpEtag) throw fail('file_changed', 412);
        const old = await this.account(path, object);
        await this.charge({requests: 0, writes: 1, units: 6});
        await check();
        const pending = {kind: 'delete', path, beforeEtag: object.etag, old};
        this.ctx.storage.transactionSync(() => this.kv.put('pending', pending));
        await this.flush();
        await check();
        try {await this.objects.delete(path, this.profile === SQLITE_PROFILE ? {beforeWrite: check} : undefined);}
        catch (error) {
          if (this.profile === SQLITE_PROFILE && error.sqliteNotWritten === true) await this.abandon(pending);
          throw error;
        }
        await this.finishDelete(pending); return new Response(null, {status: 204});
      }
      return json({error: 'method'}, 405, {Allow: 'GET, HEAD, PUT'});
    } catch (error) {return json({error: error.code || 'workspace_unavailable'}, error.status || 503);}
    finally {this.recoveryAllowance = false; this.restoreReads = false;}
  });}
}

export const workspaceFiles = env => env.FILES.get(env.FILES.idFromName('workspace'));
export async function callWorkspaceFiles(env, path, value) {
  const response = await workspaceFiles(env).fetch(new Request('https://workspace.internal' + path, value === undefined ? {} :
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)}));
  if (!response.ok) {const body = await response.json(); throw fail(body.error || 'workspace_unavailable', response.status);}
  return response.json();
}
