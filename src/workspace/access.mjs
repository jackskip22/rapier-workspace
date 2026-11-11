// SPDX-License-Identifier: AGPL-3.0-only
import {sha256} from '../kit/ledger/hash.mjs';

export const ACCESS_LEASE_MS = 30000;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const encoded = value => btoa(String.fromCharCode(...Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16))))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const ownerOf = (issuer, audience) => 'owner_' + encoded(sha256('cloudflare-workspace\0' + issuer + '\0' + audience));
const principalOf = (issuer, subject) => sha256('cloudflare-person\0' + issuer + '\0' + subject);

function issuerOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(url.hostname) &&
      !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function assertionClaims(assertion) {
  if (typeof assertion !== 'string' || assertion.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion)) return null;
  try {
    const bytes = Uint8Array.from(atob(assertion.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
    const value = JSON.parse(utf8.decode(bytes));
    return plain(value) ? value : null;
  } catch { return null; }
}

export function validAccessGrant(grant, now = Date.now()) {
  if (!(plain(grant) && ['browser', 'agent'].includes(grant.kind) && issuerOrigin(grant.issuer) === grant.issuer &&
    typeof grant.audience === 'string' && grant.audience.length > 0 && grant.audience.length <= 512 &&
    typeof grant.subject === 'string' && grant.subject.length > 0 && grant.subject.length <= 512 &&
    grant.ownerId === ownerOf(grant.issuer, grant.audience) && grant.principalId === principalOf(grant.issuer, grant.subject) &&
    Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now &&
    Number.isSafeInteger(grant.issuedAt) && grant.issuedAt <= now + 60000 && grant.issuedAt < grant.expiresAt &&
    Number.isSafeInteger(grant.checkedAt) && grant.checkedAt <= now && grant.checkedAt < grant.expiresAt)) return false;
  const claims = assertionClaims(grant.assertion);
  return !!(claims && issuerOrigin(claims.iss) === grant.issuer && claims.sub === grant.subject && claims.type === 'app' &&
    Array.isArray(claims.aud) && claims.aud.includes(grant.audience) && claims.exp * 1000 === grant.expiresAt &&
    claims.iat * 1000 === grant.issuedAt && (claims.nbf === undefined || Number.isSafeInteger(claims.nbf) && claims.nbf * 1000 <= now));
}

export async function readAccessAuthority(request, ctx, _env) {
  if (!ctx?.access || typeof ctx.access.getIdentity !== 'function' || typeof ctx.access.aud !== 'string') return null;
  let identity;
  try { identity = await ctx.access.getIdentity(); } catch { return null; }
  if (!plain(identity) || identity.service_token_status === true) return null;
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion'), claims = assertionClaims(assertion);
  const issuer = issuerOrigin(claims?.iss), audience = ctx.access.aud, now = Date.now();
  if (!issuer || !Array.isArray(claims.aud) || !claims.aud.includes(audience) ||
      claims.type !== 'app' || typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
      claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now)) return null;
  if (typeof identity.user_uuid === 'string' ? identity.user_uuid !== claims.sub
      : typeof identity.email !== 'string' || identity.email !== claims.email) return null;
  const browserCookie = (request.headers.get('Cookie') || '').split(';').some(value => value.trim() === 'CF_Authorization=' + assertion);
  const kind = browserCookie && !request.headers.has('Authorization') && !request.headers.has('Cf-Access-Token') ? 'browser' : 'agent';
  const access = Object.freeze({issuer, audience, subject: claims.sub, principalId: principalOf(issuer, claims.sub),
    ownerId: ownerOf(issuer, audience), assertion, issuedAt: claims.iat * 1000, expiresAt: claims.exp * 1000, checkedAt: now, kind});
  if (!validAccessGrant(access, now)) return null;
  return Object.freeze({source: kind === 'browser' ? 'browser' : 'access', ownerId: access.ownerId,
    connectionId: access.principalId + ':' + kind, scopes: Object.freeze(['rapier:read', 'rapier:write']), access});
}

async function identityCurrent(grant, fetchIdentity) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchIdentity(grant.issuer + '/cdn-cgi/access/get-identity', {
      method: 'GET', headers: {Cookie: 'CF_Authorization=' + grant.assertion, Accept: 'application/json'},
      redirect: 'manual', cache: 'no-store', signal: controller.signal});
    if (response.status !== 200 || !response.body) return false;
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) {await reader.cancel(); return false;}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
    const bytes = new Uint8Array(length); let at = 0;
    for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.byteLength;}
    const identity = JSON.parse(utf8.decode(bytes));
    return plain(identity) && identity.service_token_status !== true && identity.user_uuid === grant.subject;
  } catch { return false; }
  finally {clearTimeout(timer);}
}

export function accessEnvironment(env, {fetchIdentity = (...args) => fetch(...args), clock = Date.now} = {}) {
  const leases = new Map();
  const keyOf = grant => sha256(grant.assertion);
  const leaseAt = (grant, now) => {
    if (!validAccessGrant(grant, now)) return 0;
    const held = leases.get(keyOf(grant));
    const until = held && held.checkedAt >= grant.checkedAt ? held.until : Math.min(grant.expiresAt, grant.checkedAt + ACCESS_LEASE_MS);
    return until > now ? Math.min(until, grant.expiresAt) : 0;
  };
  const accessCurrent = async grant => {
    const now = clock();
    if (!validAccessGrant(grant, now)) return false;
    if (leaseAt(grant, now)) return true;
    const key = keyOf(grant), prior = leases.get(key);
    if (prior?.pending) return prior.pending;
    if (prior && prior.until === 0 && prior.checkedAt >= grant.checkedAt && prior.checkedAt + ACCESS_LEASE_MS > now) return false;
    for (const [key, row] of leases) if (!row.pending && row.checkedAt + ACCESS_LEASE_MS <= now) leases.delete(key);
    if (leases.size >= 64) {
      const spare = [...leases].find(([, row]) => !row.pending);
      if (!spare) return false;
      leases.delete(spare[0]);
    }
    const row = {checkedAt: now, until: 0};
    row.pending = (async () => {
      const accepted = await identityCurrent(grant, fetchIdentity), checkedAt = clock();
      row.checkedAt = checkedAt;
      row.until = accepted && validAccessGrant(grant, checkedAt) ? Math.min(grant.expiresAt, now + ACCESS_LEASE_MS) : 0;
      row.pending = null;
      return row.until > checkedAt;
    })();
    leases.set(key, row);
    return row.pending;
  };
  const accessRefreshNeeded = grant => {
    const now = clock();
    if (!validAccessGrant(grant, now) || leaseAt(grant, now)) return false;
    const held = leases.get(keyOf(grant));
    return !held || !!held.pending || held.until !== 0 || held.checkedAt < grant.checkedAt || held.checkedAt + ACCESS_LEASE_MS <= now;
  };
  return {...env, ACCESS_PROFILE: true, accessCurrent, accessLease: grant => leaseAt(grant, clock()), accessRefreshNeeded};
}
