// SPDX-License-Identifier: AGPL-3.0-only
import {DurableObject} from 'cloudflare:workers';
import {handleAccessMcp, RapierBudget as Budget} from '../mcp/worker.mjs';
import {configureHostedPaintRaster} from '../mcp/paint-raster.mjs';
import {configureHostedExportRenderer} from '../mcp/render-export.mjs';
import paintRasterModule from '../tools/vendor/jxl-oxide/jxl_oxide_wasm_bg.wasm';
import {readAccessAuthority, accessEnvironment} from './access.mjs';
import {WorkspaceDocument} from './document.mjs';
import {WorkspaceFilesOwner, workspaceFiles, callWorkspaceFiles} from './files.mjs';
import {workspaceAssets, workspaceAssetManifest} from './app-assets.mjs';

configureHostedPaintRaster(paintRasterModule);
configureHostedExportRenderer();

function documents(namespace) {
  return {idFromName: name => name, get: name => ({fetch(request) {
    const headers = new Headers(request.headers); headers.set('X-Workspace-Address', name);
    return namespace.get(namespace.idFromName(name)).fetch(new Request(request, {headers}));
  }})};
}

const assets = {async fetch(request) {
  const response = await workspaceAssets.fetch(request);
  if (!response.ok || request.method === 'HEAD' || !response.headers.get('Content-Type')?.includes('text/html')) return response;
  const text = await response.text();
  const html = text.replace('<head>', '<head><script>globalThis.RAPIER_WORKSPACE=/^https?:$/.test(location.protocol);</script>');
  const headers = new Headers(response.headers); headers.delete('Content-Length'); headers.delete('ETag');
  headers.set('Cache-Control', 'no-store');
  return new Response(html, {status: response.status, headers});
}};

function environment(env, origin) {
  return accessEnvironment({...env, DOCUMENTS: documents(env.DOCUMENTS), ASSETS: assets,
    ...(origin ? {OAUTH_ORIGIN: origin, UI_ORIGIN: origin, RETURN_ORIGIN: origin, ALLOWED_ORIGINS: origin} : {}),
    DOOR_PAGE_CUSTODY: '1', MAX_STATE_MIB: '8'});
}

export default {async fetch(request, bindings, ctx) {
  const authority = await readAccessAuthority(request, ctx, bindings);
  if (!authority) return Response.json({error: 'cloudflare_sign_in_required'}, {status: 401, headers: {'Cache-Control': 'no-store'}});
  const url = new URL(request.url), env = environment(bindings, url.origin);
  if (url.pathname.startsWith('/workspace/')) {
    if (!['GET', 'HEAD'].includes(request.method) && authority.source === 'browser' && request.headers.get('Origin') !== url.origin)
      return new Response(null, {status: 403});
    const headers = new Headers(request.headers);
    headers.set('X-Rapier-Access', JSON.stringify(authority.access));
    const custody = /^\/workspace\/custody\/([a-f0-9]{64})$/.exec(url.pathname);
    if (custody && request.method === 'POST' && authority.source === 'browser') {
      return env.DOCUMENTS.get(env.DOCUMENTS.idFromName(custody[1])).fetch(new Request('https://workspace.internal/custody', {
        method: 'POST', headers, body: request.body, duplex: 'half'}));
    }
    if (!['/workspace/files', '/workspace/lease', '/workspace/held'].includes(url.pathname)) return new Response(null, {status: 404});
    const internal = new URL('https://workspace.internal' + url.pathname.slice('/workspace'.length) + url.search);
    return workspaceFiles(env).fetch(new Request(internal, {method: request.method, headers, body: request.body,
      ...(request.body ? {duplex: 'half'} : {})}));
  }
  if (url.pathname === '/' || url.pathname === '/rapier.html') {
    const target = new URL('/rapier.html', request.url);
    return assets.fetch(new Request(target, {method: request.method, headers: request.headers}));
  }
  if (Object.hasOwn(workspaceAssetManifest, url.pathname)) return assets.fetch(request);
  if (!url.pathname.startsWith('/editor-assets/') && !/\.(?:png|ico|json|webmanifest)$/.test(url.pathname)) {
    try {await callWorkspaceFiles(env, '/admit', {});} catch {return Response.json({error: 'workspace_allowance_reached'}, {status: 429});}
  }
  return handleAccessMcp(request, env, authority);
}};

export class WorkspaceFiles extends DurableObject {
  constructor(ctx, env) {super(ctx, env); this.files = new WorkspaceFilesOwner(ctx, accessEnvironment(env));}
  fetch(request) {return this.files.fetch(request);}
}
export class RapierDocument extends DurableObject {
  constructor(ctx, env) {super(ctx, env); this.document = new WorkspaceDocument(ctx, environment(env));}
  fetch(request) {return this.document.fetch(request);}
  alarm() {return this.document.alarm();}
  webSocketMessage(socket, message) {return this.document.webSocketMessage(socket, message);}
  webSocketClose(socket, code, reason, wasClean) {return this.document.webSocketClose(socket, code, reason, wasClean);}
  webSocketError(socket, error) {return this.document.webSocketError(socket, error);}
}
export class RapierBudget extends DurableObject {
  constructor(ctx, env) {super(ctx, env); this.budget = new Budget(ctx, env);}
  fetch(request) {return this.budget.fetch(request);}
  alarm() {return this.budget.alarm();}
}
