// Plane A — schema discovery: target introspection (once) → fallback (Dev) → offline snapshot, with a local cache.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getIntrospectionQuery, buildClientSchema, buildSchema, printSchema, parse, validate } from 'graphql';
import { send } from './http.mjs';
import { interpolate, createVars } from './vars.mjs';
import { applyAuth, resolveAuth, collectionAuth } from './auth.mjs';
import { exists, loadEnv } from './project.mjs';
import { slug } from './util.mjs';

const DRIFT_RE = /Cannot query field|Unknown argument|Unknown type|Unknown enum value|is not defined by type/i;

function paths(project, collection, env) {
  const dir = path.join(project.root, '.hyperion');
  const name = slug(collection.config.metadata?.name ?? path.basename(collection.dir));
  return {
    dir,
    cache: path.join(dir, 'schema', `${name}.${env.name}.json`),
    state: path.join(dir, 'state.json'),
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data), 'utf8');
}

/** Why an introspection response is unusable, or null when it is fine. */
export function introspectionRejection(res) {
  if (res.status !== 200) return `HTTP ${res.status}`;
  if (!res.json) return 'non-JSON response (WAF / HTML error page?)';
  if (!res.json.data?.__schema) return res.json.errors?.[0]?.message ?? '__schema is null';
  return null;
}

/** The env whose schema stands in when the current one hides it (hyperion.yaml `schemaEnv`, default dev). */
export const schemaEnvName = (project) => project.config.schemaEnv ?? 'dev';

async function introspect({ url, headers = {}, auth, timeoutMs }, ctx) {
  const req = {
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  await applyAuth(auth, req, ctx);
  const res = await send({ ...req, body: JSON.stringify({ query: getIntrospectionQuery() }), timeoutMs: timeoutMs ?? 30000 });
  return { res, reason: introspectionRejection(res) };
}

/**
 * Fetch the schema over the network and cache it.
 * ctx: { project, collection, env, vars, saveToken, log }
 */
// 401 / 403 = "log in first", not "introspection is turned off": never remembered, retried once a token is set
const AUTH_REJECTION = /^HTTP 40[13]$/;

/**
 * targetAuth / targetHeaders: the open request's own Authorization / Headers tabs, so a token set only on the
 * request is used to read the target's schema too.
 */
export async function syncSchema(ctx, { snapshot = false, reprobe = false, targetAuth, targetHeaders } = {}) {
  const { project, collection, env, vars } = ctx;
  const log = ctx.log ?? (() => {});
  const exec = collection.config.execution ?? {};
  // no schemaDiscovery block: still try the target, then the dev env
  const sd = collection.config.schemaDiscovery ?? { mode: 'AUTO_FALLBACK' };
  const mode = sd.mode ?? 'AUTO_FALLBACK';
  const p = paths(project, collection, env);
  const state = await readJson(p.state, { introspectionDisabled: {} });
  const i = (v) => interpolate(v, vars);

  const target = {
    kind: 'target',
    url: i(exec.url),
    headers: i({ ...(exec.headers ?? {}), ...(targetHeaders ?? {}) }),
    auth: resolveAuth(collectionAuth(collection.config, env.name), targetAuth),
    plane: 'execution',
  };
  // an explicit fallbackUrl only counts when it resolves (SCHEMA_URL is optional)
  const missing = [];
  const fallbackUrl = sd.fallbackUrl ? interpolate(sd.fallbackUrl, vars, missing) : null;
  const fallback = fallbackUrl && !missing.length && {
    kind: 'fallback',
    url: fallbackUrl,
    headers: i(sd.headers ?? {}),
    auth: resolveAuth(sd.auth),
    plane: 'schema',
  };
  // last network option: the dev env's own endpoint, with dev's variables and login
  const devName = schemaEnvName(project);
  let devAttempt = null;
  if (env.name !== devName && (await exists(path.join(project.root, 'envs', `${devName}.env.yaml`)))) {
    const devEnv = await loadEnv(project, devName);
    const devVars = createVars({ global: project.config.variables, collection: collection.config.variables, env: devEnv, secrets: project.secrets });
    const devMissing = [];
    const url = interpolate(exec.url, devVars, devMissing);
    if (!devMissing.length) {
      devAttempt = { kind: devName, url, headers: interpolate(exec.headers ?? {}, devVars), auth: resolveAuth(collectionAuth(collection.config, devName)), plane: 'execution', ctx: { env: devEnv, vars: devVars } };
    }
  }

  const attempts = [];
  if (mode === 'TARGET_ONLY') attempts.push(target);
  if (mode === 'FALLBACK_ONLY') attempts.push(fallback, devAttempt);
  if (mode === 'AUTO_FALLBACK') {
    const known = state.introspectionDisabled[target.url];
    if (sd.probeTarget === false) log(`schema: skipping target (probeTarget: false)`);
    else if (known && !reprobe && !AUTH_REJECTION.test(known.reason)) log(`schema: skipping target, introspection known disabled since ${known.at} (${known.reason}); use --reprobe to retry`);
    else attempts.push(target);
    attempts.push(fallback);
    if (!fallback || fallback.url !== devAttempt?.url) attempts.push(devAttempt);
  }

  const failures = [];
  let targetRejected = null; // why the env's own endpoint gave no schema, shown next to a fallback schema
  for (const a of attempts.filter(Boolean)) {
    try {
      const { res, reason } = await introspect(a, { ...ctx, ...a.ctx, plane: a.plane });
      if (reason) {
        failures.push(`${a.kind} ${a.url}: ${reason}`);
        if (a.kind === 'target') {
          targetRejected = reason;
          if (AUTH_REJECTION.test(reason)) {
            log(`schema: ${env.name} needs a token (${reason}) — using another schema until one is set`);
            delete state.introspectionDisabled[a.url];
          } else {
            log(`schema: ${a.kind} rejected introspection (${reason})`);
            state.introspectionDisabled[a.url] = { at: new Date().toISOString(), reason };
          }
          await writeJson(p.state, state);
        } else log(`schema: ${a.kind} rejected introspection (${reason})`);
        continue;
      }
      const introspection = res.json.data;
      const schema = buildClientSchema(introspection);
      const sdl = printSchema(schema);
      const meta = {
        source: a.kind,
        url: a.url,
        fetchedAt: new Date().toISOString(),
        hash: createHash('sha256').update(sdl).digest('hex').slice(0, 12),
        types: Object.keys(schema.getTypeMap()).filter((t) => !t.startsWith('__')).length,
        ...(a.kind !== 'target' && targetRejected ? { targetRejected } : {}),
      };
      await writeJson(p.cache, { meta, introspection });
      loaded.clear(); // other envs may borrow this one
      log(`schema: loaded from ${a.kind} ${a.url} — ${meta.types} types, sha ${meta.hash}`);
      if (snapshot && sd.offlineSnapshot) {
        const snapFile = path.resolve(collection.dir, sd.offlineSnapshot);
        await mkdir(path.dirname(snapFile), { recursive: true });
        await writeFile(snapFile, `# source: ${a.url}\n# fetched: ${meta.fetchedAt}\n${sdl}\n`, 'utf8');
        log(`schema: snapshot written to ${path.relative(project.root, snapFile)}`);
      }
      return { schema, meta };
    } catch (err) {
      failures.push(`${a.kind} ${a.url}: ${err.message}`);
      log(`schema: ${a.kind} failed (${err.message})`);
    }
  }

  const fromSnapshot = await loadSnapshot(ctx);
  if (fromSnapshot) {
    log(`schema: using offline snapshot ${fromSnapshot.meta.url}`);
    return fromSnapshot;
  }
  throw new Error(`could not get a schema:\n  - ${failures.join('\n  - ') || 'no source configured'}`);
}

async function loadSnapshot({ collection }) {
  const file = collection.config.schemaDiscovery?.offlineSnapshot;
  if (!file) return null;
  const full = path.resolve(collection.dir, file);
  if (!(await exists(full))) return null;
  const schema = buildSchema(await readFile(full, 'utf8'));
  return { schema, meta: { source: 'snapshot', url: full, fetchedAt: null, stale: false } };
}

const loaded = new Map();

export function forgetSchemas() {
  loaded.clear();
}

/** Schema from cache (or snapshot) — never touches the network. Returns null when none is available. */
export async function loadSchema(ctx) {
  const p = paths(ctx.project, ctx.collection, ctx.env);
  if (!loaded.has(p.cache)) {
    loaded.set(
      p.cache,
      (async () => {
        const ttl = (ctx.collection.config.schemaDiscovery?.cacheTtlMinutes ?? 1440) * 60000;
        const fromCache = (cached, extra = {}) => ({
          schema: buildClientSchema(cached.introspection),
          meta: { ...cached.meta, ...extra, stale: Date.now() - Date.parse(cached.meta.fetchedAt) > ttl },
        });
        const cached = await readJson(p.cache, null);
        if (cached) return fromCache(cached);
        // nothing synced for this env yet (e.g. prod hides its schema): reuse dev's, else the newest any env has
        const devName = schemaEnvName(ctx.project);
        const devCached = await readJson(paths(ctx.project, ctx.collection, { name: devName }).cache, null);
        if (devCached) return fromCache(devCached, { source: devName, borrowed: true });
        const dir = path.dirname(p.cache);
        const prefix = path.basename(p.cache).split('.')[0] + '.';
        const others = [];
        for (const f of await readdir(dir).catch(() => [])) {
          if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
          const c = await readJson(path.join(dir, f), null);
          if (c) others.push({ env: f.slice(prefix.length, -5), c });
        }
        others.sort((x, y) => Date.parse(y.c.meta.fetchedAt) - Date.parse(x.c.meta.fetchedAt));
        if (others[0]) return fromCache(others[0].c, { source: others[0].env, borrowed: true });
        return loadSnapshot(ctx);
      })(),
    );
  }
  return loaded.get(p.cache);
}

export function validateQuery(schema, query) {
  try {
    return validate(schema, parse(query)).map((e) => e.message);
  } catch (err) {
    return [err.message];
  }
}

/** GraphQL errors that look like the schema we autocompleted from does not match the target. */
export function driftErrors(json) {
  return (json?.errors ?? []).map((e) => e.message).filter((m) => DRIFT_RE.test(m));
}
