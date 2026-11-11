// SPDX-License-Identifier: AGPL-3.0-only
import {RapierDocument} from '../mcp/worker.mjs';
import {validHandover} from '../mcp/page-door.mjs';
import {custodyRecovery, recoverFrame, durableCustody} from '../mcp/custody-recovery.mjs';
import {sha256} from '../kit/ledger/hash.mjs';
import {callWorkspaceFiles, workspaceFiles, boundedBytes, WORKSPACE_LIMITS} from './files.mjs';
import {createWorkspaceNotes} from '../notes/workspace-store.mjs';
import {createFolder} from '../notes/folder.mjs';
import {createNotesAgentHost} from '../notes/agent-host.mjs';

const fields = ['stateFormat', 'documentId', 'ownerKey', 'capabilityHash', 'prefix', 'version', 'createdAt', 'pairEpoch',
  'agentAccess', 'rotations', 'rotatedAt', 'rotation', 'liveStopped', 'receipts'];
const durableHead = head => Object.fromEntries(fields.filter(key => head[key] !== undefined).map(key => [key, head[key]]));
const addressOf = head => sha256(head.ownerKey + ':' + head.prefix);

export class WorkspaceDocument extends RapierDocument {
  constructor(ctx, env) {
    super(ctx, {...env, MAX_STATE_MIB: '8', DOOR_PAGE_CUSTODY: '1'});
    this.recoveryWire = null; this.restoring = false; this.ready = null;
    this.notesRefs = new Map(); this.notesReadReceipts = new Map();
    this.notesProvider = null; this.notesInvocation = null; this.notesTail = Promise.resolve();
  }

  async notesHost(input) {
    if (this.env.ACCESS_PROFILE !== true || !['agent', 'browser'].includes(input.access?.kind)) return null;
    if (!this.notesProvider) {
      const events = new EventTarget();
      const channel = {addEventListener: (...args) => events.addEventListener(...args),
        removeEventListener: (...args) => events.removeEventListener(...args),
        postMessage(data) {const event = new Event('message'); Object.defineProperty(event, 'data', {value: structuredClone(data)}); events.dispatchEvent(event);}};
      const workspace = createWorkspaceNotes({url: 'https://workspace.internal/app', channel, fetch: async (url, init) => {
        const invocation = this.notesInvocation;
        if (!invocation) throw Object.assign(new Error('notes_owner_unavailable'), {code: 'notes_owner_unavailable'});
        const path = new URL(url);
        if (path.origin !== 'https://workspace.internal' || !['/workspace/files', '/workspace/lease'].includes(path.pathname))
          throw Object.assign(new Error('notes_owner_unavailable'), {code: 'notes_owner_unavailable'});
        const headers = new Headers(init.headers);
        headers.set('X-Rapier-Access', JSON.stringify(invocation.access));
        path.pathname = path.pathname.slice('/workspace'.length);
        return workspaceFiles(this.env).fetch(new Request(path, {...init, headers, redirect: 'manual'}));
      }});
      this.notesProvider = {workspace, folder: createFolder({...workspace, shared: true})};
    }
    const {workspace, folder} = this.notesProvider, invocation = {access: structuredClone(input.access)};
    const host = createNotesAgentHost({folder, refs: this.notesRefs, readReceipts: this.notesReadReceipts, guard: () => {
      input.signal?.throwIfAborted();
      if (this.notesInvocation !== invocation) throw Object.assign(new Error('notes_changed'), {code: 'notes_changed', notesMutationStarted: false});
    }});
    return Object.fromEntries(Object.entries(host).map(([name, value]) => [name, typeof value !== 'function' ? value : async request => {
      const prior = this.notesTail; let release;
      this.notesTail = new Promise(resolve => {release = resolve;});
      await prior;
      this.notesInvocation = invocation;
      try {
        await this.assertAuthority(input);
        await workspace.store.prepare();
        return await value(request);
      } finally {
        try {await folder.settle();}
        finally {this.notesInvocation = null; release();}
      }
    }]));
  }

  async prepareRecovery() {
    const deleting = this.ctx.storage.kv.get('workspace:deleting');
    if (deleting) {
      try {
        await callWorkspaceFiles(this.env, '/retire', deleting);
        this.cachedState = null; this.cachedJournal = null;
        await this.ctx.storage.deleteAll(); await this.ctx.storage.sync();
        this.live.reset(); this.live.expire(null); return;
      } catch (error) {
        if (error.status !== 401) throw error;
        this.ctx.storage.transactionSync(() => this.ctx.storage.kv.delete('workspace:deleting'));
        await this.ctx.storage.sync();
      }
    }
    const head = this.ctx.storage.kv.get('head');
    if (head && head.expiresAt > Date.now() && !this.ctx.storage.kv.get('workspace:pending')) return;
    const address = this.address || this.ctx.storage.kv.get('workspace:address');
    if (!address) return;
    let value;
    try {value = await callWorkspaceFiles(this.env, '/recovery?address=' + address);}
    catch (error) {if (error.status === 404) return; throw error;}
    await this.restore(value);
    this.ctx.storage.transactionSync(() => this.ctx.storage.kv.delete('workspace:pending'));
    await this.ctx.storage.sync();
  }

  async restore(value) {
    if (!validHandover(value) || addressOf(value.head) !== value.address) throw new Error('workspace_recovery_invalid');
    this.restoring = true;
    try {
      this.cachedState = null; this.cachedJournal = null; this.live.reset();
      const head = this.describe(value.state, {...value.head}, value.head.version, {});
      if (this.ctx.storage.kv.get('head')?.expiresAt <= Date.now()) this.ctx.storage.transactionSync(() => this.ctx.storage.kv.delete('head'));
      await super.persist(head, value.state, value.journal);
      this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put('workspace:address', value.address));
      await this.ctx.storage.sync();
    } finally {this.restoring = false;}
  }

  async beforePersist(head, state, journal, authority) {
    if (this.restoring) return;
    const previous = this.ctx.storage.kv.get('head');
    if (!state && previous) state = this.readState(previous);
    if (!Array.isArray(journal) && previous) journal = this.readJournal();
    if (!state || !Array.isArray(journal)) return;
    if (authority) await this.assertAuthority(authority);
    const grants = (Array.isArray(authority) ? authority : [authority]).filter(Boolean).map(input => input.access || input.page?.access).filter(Boolean);
    const address = addressOf(head), recovery = durableCustody({address, head: durableHead(head), state, journal});
    if (new TextEncoder().encode(state.text).byteLength > WORKSPACE_LIMITS.sourceBytes) throw new RangeError('workspace_source_too_large');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put('workspace:address', address);
      this.ctx.storage.kv.put('workspace:pending', true);
    });
    await this.ctx.storage.sync();
    await callWorkspaceFiles(this.env, '/commit', {custody: recovery, ...(grants.length ? {access: grants} : {})});
  }

  async persist(...args) {
    try {
      await super.persist(...args);
      if (!this.restoring && this.ctx.storage.kv.get('workspace:pending')) {
        this.ctx.storage.transactionSync(() => this.ctx.storage.kv.delete('workspace:pending'));
        await this.ctx.storage.sync();
      }
    } catch (error) {this.ready = null; this.needsFileRecovery = true; throw error;}
  }

  async keepCustody(frame, access) {
    const head = this.ctx.storage.kv.get('head');
    if (!head?.custody || !access || !await this.env.accessCurrent(access) || head.ownerKey !== sha256(access.ownerId))
      throw new Error('custody_recovery_refused');
    let previous = this.recoveryWire;
    if (!previous && frame.base) {
      const kept = await callWorkspaceFiles(this.env, '/recovery?address=' + addressOf(head));
      previous = custodyRecovery(this.pageHandover(kept));
    }
    const decoded = recoverFrame(frame, previous), held = decoded.value;
    if (!validHandover(held) || held.head.capabilityHash !== head.capabilityHash || held.state.documentId !== head.documentId ||
        held.state.revision < (head.custody.durableRevision ?? head.custody.since)) throw new Error('custody_recovery_refused');
    const known = this.pageRecovery || await callWorkspaceFiles(this.env, '/recovery?address=' + addressOf(head));
    this.live.prepare(held.state, known.state);
    const durable = {address: addressOf(head), head: durableHead({...head, version: held.head.version}), state: held.state, journal: held.journal};
    await callWorkspaceFiles(this.env, '/commit', {custody: durable, access});
    if (!await this.env.accessCurrent(access)) throw new Error('custody_recovery_refused');
    const next = {...head, custody: {...head.custody, durableRevision: held.state.revision, durableHash: frame.hash}};
    this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put('head', next));
    await this.ctx.storage.sync();
    this.recoveryWire = decoded.next; this.pageRecovery = durable;
    return {hash: frame.hash, revision: held.state.revision};
  }

  pageHandover(value) {
    return {state: value.state, journal: value.journal,
      head: {documentId: value.state.documentId, capabilityHash: value.head.capabilityHash, version: value.head.version,
        durable: true, durabilityPath: this.durabilityPath(value.head)},
      rev: value.state.revision, hash: sha256(value.state.text)};
  }

  durabilityPath(head) {return '/workspace/custody/' + addressOf(head);}

  async recoverCustody(head) {
    const value = await callWorkspaceFiles(this.env, '/recovery?address=' + addressOf(head));
    if (value.head.capabilityHash !== head.capabilityHash) throw new Error('workspace_recovery_changed');
    this.recoveryWire = null; this.pageRecovery = null;
    return this.pageHandover(value);
  }

  async beforeDocumentDelete(head, input) {
    const access = input.access || input.page?.access, value = {address: addressOf(head), access};
    await this.assertAuthority(input);
    this.ctx.storage.transactionSync(() => this.ctx.storage.kv.put('workspace:deleting', value));
    await this.ctx.storage.sync();
    try {await callWorkspaceFiles(this.env, '/retire', value);}
    catch (error) {this.ready = null; throw error;}
  }

  async beforeHeadChange(head, input) {
    const kept = await callWorkspaceFiles(this.env, '/recovery?address=' + addressOf(head));
    await this.beforePersist(head, kept.state, kept.journal, input);
  }

  async fetch(request) {
    const address = request.headers.get('X-Workspace-Address');
    if (/^[a-f0-9]{64}$/.test(address || '')) this.address = address;
    const head = this.ctx.storage.kv.get('head');
    if (!head || head.expiresAt <= Date.now() || this.ctx.storage.kv.get('workspace:pending') ||
        this.ctx.storage.kv.get('workspace:deleting')) this.ready = null;
    if (!this.ready) this.ready = this.exclusive(async () => {
      await this.prepareRecovery(); this.needsFileRecovery = false;
    }).catch(error => {this.ready = null; throw error;});
    try {await this.ready;} catch {return Response.json({error: 'workspace_recovery_unavailable'}, {status: 503});}
    if (new URL(request.url).pathname === '/custody' && request.method === 'POST') return this.exclusive(async () => {
      try {
        const access = JSON.parse(request.headers.get('X-Rapier-Access'));
        if (access.kind !== 'browser' || !await this.env.accessCurrent(access)) return new Response(null, {status: 401});
        const raw = await boundedBytes(request, WORKSPACE_LIMITS.recoveryBytes * 2);
        const result = await this.keepCustody(JSON.parse(new TextDecoder().decode(raw)), access);
        return Response.json({kept: true, ...result}, {headers: {'Cache-Control': 'no-store'}});
      } catch {return Response.json({kept: false}, {status: 503});}
    });
    return super.fetch(request);
  }
}
