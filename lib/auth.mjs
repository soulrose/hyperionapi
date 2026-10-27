// Auth providers: bearer, apiKey, basic, tokenEndpoint (login → cache → refresh on expiry/401 → saveToEnv).
import { send } from './http.mjs';
import { interpolate } from './vars.mjs';
import { saveLocalEnvVars } from './project.mjs';
import { getPath, jwtExpiryMs, findHeader, setHeader } from './util.mjs';

/** Pick the effective auth from low → high precedence layers ("inherit"/undefined skip, "none" clears). */
export function resolveAuth(...layers) {
  let auth = null;
  for (const a of layers) {
    if (a == null || a === 'inherit' || a?.type === 'inherit') continue;
    auth = a === 'none' || a?.type === 'none' ? null : a;
  }
  return auth;
}

/** A collection's auth for one env: execution.authByEnv.<env> when that env has its own, else execution.auth. */
export function collectionAuth(config, envName) {
  const ex = config?.execution ?? {};
  return ex.authByEnv?.[envName] ?? ex.auth;
}

const DEFAULT_NAMES = {
  execution: { accessToken: 'ACCESS_TOKEN', refreshToken: 'REFRESH_TOKEN', expiresAt: 'TOKEN_EXPIRES_AT' },
  schema: { accessToken: 'SCHEMA_ACCESS_TOKEN', refreshToken: 'SCHEMA_REFRESH_TOKEN', expiresAt: 'SCHEMA_TOKEN_EXPIRES_AT' },
};

export function tokenVarNames(cfg, plane = 'execution') {
  return { ...DEFAULT_NAMES[plane], ...(cfg?.saveToEnv ?? {}) };
}

/**
 * Apply auth to a resolved request ({url, headers}) in place.
 * Returns warnings (e.g. a hand-written header that auth overrides).
 */
export async function applyAuth(auth, req, ctx, { force = false } = {}) {
  if (!auth) return [];
  const warnings = [];
  // an unset {{variable}} in auth must not be sent as literal text (the server just answers 401)
  const i = (v) => {
    const missing = [];
    const out = interpolate(v, ctx.vars, missing);
    if (missing.length) {
      throw new Error(`Auth uses variables that are not set: ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')} — set them in the env or switch Authorization to "Inherit from collection"`);
    }
    return out;
  };
  const putHeader = (name, value) => {
    if (findHeader(req.headers, name)) warnings.push(`auth overrides header "${name}"`);
    setHeader(req.headers, name, value);
  };
  const putQuery = (name, value) => {
    const u = new URL(req.url);
    u.searchParams.set(name, value);
    req.url = u.toString();
  };

  switch (auth.type) {
    case 'bearer':
      putHeader('Authorization', `Bearer ${i(auth.bearer?.token ?? auth.token)}`);
      break;
    case 'apiKey': {
      const k = auth.apiKey ?? auth;
      const name = k.name ?? k.header;
      if ((k.in ?? 'header') === 'query') putQuery(name, i(k.value));
      else putHeader(name, i(k.value));
      break;
    }
    case 'basic': {
      const b = auth.basic ?? auth;
      putHeader('Authorization', `Basic ${Buffer.from(`${i(b.username)}:${i(b.password)}`).toString('base64')}`);
      break;
    }
    case 'tokenEndpoint': {
      const cfg = auth.tokenEndpoint ?? auth;
      const token = await getToken(cfg, ctx, { force });
      const apply = cfg.apply ?? { header: 'Authorization', prefix: 'Bearer ' };
      if (apply.query) putQuery(apply.query, token);
      else putHeader(apply.header ?? 'Authorization', `${apply.prefix ?? ''}${token}`);
      break;
    }
    default:
      throw new Error(`Unknown auth type "${auth.type}"`);
  }
  return warnings;
}

// One refresh per env+plane at a time: concurrent requests share the same promise.
const inflight = new Map();

export function tokenState(cfg, ctx) {
  const names = tokenVarNames(cfg, ctx.plane);
  const token = ctx.vars.get(names.accessToken);
  const exp = ctx.vars.get(names.expiresAt);
  const expMs = exp ? Date.parse(exp) : jwtExpiryMs(token);
  return { names, token, expMs, refreshToken: ctx.vars.get(names.refreshToken) };
}

export async function getToken(cfg, ctx, { force = false } = {}) {
  const skewMs = (cfg.skewSeconds ?? 60) * 1000;
  const st = tokenState(cfg, ctx);
  if (!force && st.token && (st.expMs == null || st.expMs - skewMs > Date.now())) return st.token;

  const key = `${ctx.env.name}:${ctx.plane ?? 'execution'}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = renewToken(cfg, ctx, st).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function renewToken(cfg, ctx, st) {
  const log = ctx.log ?? (() => {});
  let result;
  let via;
  if (cfg.refresh && st.refreshToken) {
    try {
      result = await callTokenEndpoint({ tokenPath: cfg.tokenPath, form: cfg.form, ...cfg.refresh }, ctx);
      via = 'refresh';
    } catch (err) {
      log(`token: refresh failed (${err.message}), logging in again`);
    }
  }
  if (!result) {
    result = await callTokenEndpoint(cfg, ctx);
    via = 'login';
  }

  const json = result.json;
  const token = getPath(json, cfg.tokenPath ?? 'accessToken');
  if (!token) throw new Error(`token endpoint response has no "${cfg.tokenPath ?? 'accessToken'}"`);
  const refreshPath = cfg.refresh?.refreshTokenPath ?? cfg.refreshTokenPath ?? 'refreshToken';
  const newRefresh = getPath(json, refreshPath) ?? st.refreshToken;

  let expMs = null;
  if (typeof cfg.expiresIn === 'number') expMs = Date.now() + cfg.expiresIn * 1000;
  else {
    expMs = jwtExpiryMs(token);
    const secs = getPath(json, cfg.expiresInPath ?? 'expires_in') ?? getPath(json, 'expiresIn');
    if (expMs == null && typeof secs === 'number') expMs = Date.now() + secs * 1000;
  }

  const updates = {
    [st.names.accessToken]: token,
    [st.names.refreshToken]: newRefresh ?? null,
    [st.names.expiresAt]: expMs ? new Date(expMs).toISOString() : null,
  };
  // Runtime scope sees the new token immediately; the local overlay keeps it across runs.
  for (const [k, v] of Object.entries(updates)) if (v != null) ctx.vars.runtime[k] = v;
  if (ctx.saveToken) await saveLocalEnvVars(ctx.env, updates);
  const until = expMs ? new Date(expMs).toLocaleTimeString() : 'unknown expiry';
  log(`token: ${via === 'refresh' ? 'refreshed' : 'new login'} (${ctx.plane ?? 'execution'}, until ${until})${ctx.saveToken ? `, saved to ${ctx.env.name}.local.env.yaml` : ''}`);
  return token;
}

async function callTokenEndpoint(c, ctx) {
  const i = (v) => {
    const missing = [];
    const out = interpolate(v, ctx.vars, missing);
    if (missing.length) throw new Error(`token endpoint: unresolved ${missing.map((m) => `{{${m}}}`).join(', ')}`);
    return out;
  };
  // form: true = application/x-www-form-urlencoded, what OAuth2 / OpenID (Keycloak) token endpoints expect;
  // empty values (e.g. no client_secret) are left out
  const body = c.body == null ? undefined : i(c.body);
  const res = await send({
    method: c.method ?? 'POST',
    url: i(c.url),
    headers: { 'Content-Type': c.form ? 'application/x-www-form-urlencoded' : 'application/json', ...i(c.headers ?? {}) },
    body: body === undefined ? undefined : c.form ? new URLSearchParams(Object.entries(body).filter(([, v]) => v !== '' && v != null)).toString() : JSON.stringify(body),
    timeoutMs: c.timeoutMs ?? 15000,
  });
  if (!res.ok || !res.json) {
    const why = res.json?.error_description ?? res.json?.error ?? res.json?.message;
    throw new Error(`token endpoint ${i(c.url)} → HTTP ${res.status}${why ? ` (${why})` : ''}`);
  }
  return res;
}

/** tokenEndpoint config for an OpenID Connect / Keycloak password login, reading the env's KC_* variables. */
export function keycloakAuth() {
  return {
    type: 'tokenEndpoint',
    tokenEndpoint: {
      kind: 'keycloak',
      url: '{{KC_TOKEN_URL}}',
      form: true,
      body: { grant_type: 'password', client_id: '{{KC_CLIENT_ID}}', client_secret: '{{KC_CLIENT_SECRET}}', username: '{{KC_USERNAME}}', password: '{{KC_PASSWORD}}' },
      tokenPath: 'access_token',
      refreshTokenPath: 'refresh_token',
      expiresInPath: 'expires_in',
      refresh: {
        url: '{{KC_TOKEN_URL}}',
        body: { grant_type: 'refresh_token', client_id: '{{KC_CLIENT_ID}}', client_secret: '{{KC_CLIENT_SECRET}}', refresh_token: '{{REFRESH_TOKEN}}' },
      },
      skewSeconds: 30,
    },
  };
}

export async function clearToken(cfg, ctx) {
  const names = tokenVarNames(cfg, ctx.plane);
  for (const n of Object.values(names)) delete ctx.vars.runtime[n];
  await saveLocalEnvVars(ctx.env, Object.fromEntries(Object.values(names).map((n) => [n, null])));
}
