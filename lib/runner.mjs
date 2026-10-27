// Plane B — execute one request file: build → guard → validate → beforeRequest → auth → send (401 → refresh, retry once)
// → afterResponse tests → drift check.
import path from 'node:path';
import { parse } from 'graphql';
import { loadRequest } from './project.mjs';
import { createVars, interpolate } from './vars.mjs';
import { resolveAuth, applyAuth, getToken, collectionAuth } from './auth.mjs';
import { RT_KINDS } from './realtime.mjs';
import { send } from './http.mjs';
import { loadSchema, validateQuery, driftErrors } from './schema.mjs';
import { runScript, createTestApi } from './script.mjs';
import { findHeader, setHeader } from './util.mjs';

export function operationType(query, operationName) {
  try {
    const ops = parse(query).definitions.filter((d) => d.kind === 'OperationDefinition');
    const op = (operationName && ops.find((o) => o.name?.value === operationName)) || ops[0];
    return op?.operation ?? 'query';
  } catch {
    return 'query';
  }
}

const merge = (...objs) => Object.assign({}, ...objs.filter(Boolean));

/**
 * opts: { project, env, data, flow, runtime, saveToken, confirm, log, validate }
 * Shared `runtime`/`flow` objects let consecutive requests pass values along.
 */
export async function runRequest(file, opts) {
  const { project, env } = opts;
  const log = opts.log ?? (() => {});
  const { request, collection, folders } = await loadRequest(file);
  const name = request.metadata?.name ?? path.basename(file, '.req.yaml');
  const result = { name, file, kind: request.kind, status: null, timeMs: null, tests: [], warnings: [], error: null };
  if (RT_KINDS[request.kind]) {
    result.error = `${request.kind} is a persistent connection — open it in the app and press Connect (not supported in flow / hyperion run)`;
    return result;
  }

  const vars = createVars({
    global: project.config.variables,
    collection: merge(collection.config.variables, ...folders.map((f) => f.variables), request.variables),
    env,
    data: opts.data,
    flow: opts.flow,
    runtime: opts.runtime,
    secrets: project.secrets,
  });
  const ctx = { project, env, collection, vars, saveToken: opts.saveToken, log, plane: 'execution' };

  // ---- build raw request (templates still unresolved)
  const exec = merge(collection.config.execution, ...folders.map((f) => f.execution), request.execution);
  // the UI may send the request's own auth/headers as edited (not yet saved)
  const ov = opts.override ?? {};
  const reqHeaders = ov.headers !== undefined ? ov.headers : request.execution?.headers ?? request.headers;
  const reqAuth = ov.auth !== undefined ? ov.auth : request.execution?.auth ?? request.auth;
  const scripts = ov.scripts !== undefined ? ov.scripts : request.scripts; // as edited in the Scripts tab
  const headers = merge(collection.config.execution?.headers, ...folders.map((f) => f.execution?.headers ?? f.headers), reqHeaders);
  const auth = resolveAuth(collectionAuth(collection.config, env.name), ...folders.map((f) => f.execution?.auth ?? f.auth), reqAuth);
  const isGraphQL = request.kind !== 'HttpRequest';
  const raw = isGraphQL
    ? {
        method: 'POST',
        url: exec.url,
        headers,
        query: request.payload?.query ?? '',
        variables: { ...(request.payload?.variables ?? {}) },
        operationName: request.payload?.operationName,
      }
    : { method: (request.method ?? 'GET').toUpperCase(), url: request.url, headers, query: undefined, params: request.params, body: request.body };

  if (opts.override?.query != null) raw.query = opts.override.query;
  if (opts.override?.variables != null) raw.variables = { ...opts.override.variables };

  // ---- prod guard
  const opType = isGraphQL ? operationType(raw.query, raw.operationName) : null;
  const writes = isGraphQL ? opType === 'mutation' : !['GET', 'HEAD', 'OPTIONS'].includes(raw.method);
  const confirmName = raw.operationName ?? name;
  result.operation = { type: opType, name: raw.operationName };
  // confirm: true = the app sends writes on protected envs as-is (user's choice); the CLI still needs --confirm <name>
  if (env.protected && writes && opts.confirm !== true && opts.confirm !== confirmName) {
    result.blocked = true;
    result.error = `blocked: ${isGraphQL ? 'mutation' : raw.method} on protected env "${env.name}" — confirm with --confirm ${confirmName}`;
    return result;
  }

  // ---- local validation against cached schema (warn only: Dev schema may be ahead of/behind Prod)
  if (isGraphQL && opts.validate !== false) {
    const s = await loadSchema(ctx).catch((e) => ({ error: e }));
    if (s?.schema) {
      result.schemaSource = s.meta;
      for (const m of validateQuery(s.schema, raw.query)) result.warnings.push(`schema (${s.meta.source}): ${m}`);
      if (s.meta.stale) result.warnings.push('schema cache is stale — run "hyperion schema sync"');
    } else if (s?.error) result.warnings.push(`schema load failed: ${s.error.message}`);
  }

  // ---- $req: scripts see resolved values on get(), set() writes literal values
  const resolve = (v) => interpolate(v, vars);
  const $req = {
    get url() { return resolve(raw.url); },
    set url(v) { raw.url = v; },
    get query() { return raw.query; },
    set query(v) { raw.query = v; },
    get method() { return raw.method; },
    headers: {
      get: (k) => resolve(raw.headers[findHeader(raw.headers, k)]),
      set: (k, v) => setHeader(raw.headers, k, v),
      delete: (k) => delete raw.headers[findHeader(raw.headers, k)],
    },
    variables: {
      get: (k) => resolve(raw.variables?.[k]),
      set: (k, v) => void ((raw.variables ??= {})[k] = v),
    },
  };
  const tests = createTestApi();
  const scriptApi = {
    $req,
    $env: { get: (k) => vars.get(k), set: (k, v) => void (vars.runtime[k] = v), where: (k) => vars.whereIs(k) },
    $secret: { get: (k) => vars.secret(k) },
    $flow: { get: (k) => vars.flow[k], set: (k, v) => void (vars.flow[k] = v) },
    $http: httpApi(env),
    $auth: {
      token: async () => (auth?.type === 'tokenEndpoint' ? getToken(auth.tokenEndpoint ?? auth, ctx) : null),
      refresh: async () => (auth?.type === 'tokenEndpoint' ? getToken(auth.tokenEndpoint ?? auth, ctx, { force: true }) : null),
    },
    $test: tests.$test,
    $expect: tests.$expect,
    console: { log: (...a) => log(`console: ${a.map(String).join(' ')}`) },
  };

  try {
    await runScript(scripts?.beforeRequest, scriptApi, { label: `${name} beforeRequest` });

    // ---- resolve templates
    const missing = [];
    const final = {
      method: raw.method,
      url: interpolate(raw.url, vars, missing),
      headers: interpolate(raw.headers, vars, missing),
    };
    let body;
    if (isGraphQL) {
      body = { query: raw.query, variables: interpolate(raw.variables, vars, missing) };
      if (raw.operationName) body.operationName = raw.operationName;
    } else if (raw.body !== undefined) body = interpolate(raw.body, vars, missing);
    if (!isGraphQL && raw.params) {
      const u = new URL(final.url);
      for (const [k, v] of Object.entries(interpolate(raw.params, vars, missing))) u.searchParams.set(k, v);
      final.url = u.toString();
    }
    if (missing.length) throw new Error(`unresolved variables: ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')}`);
    if (body !== undefined && typeof body !== 'string') {
      if (!findHeader(final.headers, 'content-type')) final.headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    result.request = { method: final.method, url: final.url, body: isGraphQL ? JSON.parse(body) : body };

    // ---- auth + send (401 → force refresh, retry once)
    const sendOnce = async (force) => {
      const r = { ...final, headers: { ...final.headers } };
      result.warnings.push(...(await applyAuth(auth, r, ctx, { force })));
      return send({ ...r, body, timeoutMs: exec.timeoutMs ?? request.timeoutMs ?? 15000 });
    };
    let res = await sendOnce(false);
    if (res.status === 401 && auth?.type === 'tokenEndpoint') {
      log('token: got 401, refreshing and retrying once');
      res = await sendOnce(true);
    }
    result.status = res.status;
    result.timeMs = res.timeMs;
    result.size = res.size;
    result.response = { status: res.status, headers: res.headers, json: res.json, text: res.json ? undefined : res.text };

    for (const m of driftErrors(res.json)) result.warnings.push(`schema drift — target rejects what the schema source allowed: ${m}`);

    const $res = { status: res.status, headers: res.headers, json: res.json, text: res.text, timeMs: res.timeMs };
    $req.variables.get = (k) => result.request.body?.variables?.[k];
    await runScript(scripts?.afterResponse, { ...scriptApi, $res }, { label: `${name} afterResponse` });
  } catch (err) {
    result.error = err.message;
  }
  result.tests = await tests.results();
  // Without tests: HTTP must be < 400 and, for GraphQL, the response must carry no errors[].
  const gqlErrors = isGraphQL && Array.isArray(result.response?.json?.errors) && result.response.json.errors.length > 0;
  result.passed = !result.error && result.status != null && result.tests.every((t) => t.pass) && (result.tests.length > 0 || (result.status < 400 && !gqlErrors));
  return result;
}

function httpApi(env) {
  const allowed = (url) => {
    if (!env.httpAllowlist?.length) return;
    const host = new URL(url).host;
    if (!env.httpAllowlist.includes(host)) throw new Error(`$http: host ${host} not in httpAllowlist of env ${env.name}`);
  };
  const call = (method) => async (url, { headers = {}, body, timeoutMs } = {}) => {
    allowed(url);
    const h = { ...headers };
    if (body !== undefined && typeof body !== 'string' && !findHeader(h, 'content-type')) h['Content-Type'] = 'application/json';
    return send({ method, url, headers: h, body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body), timeoutMs });
  };
  return { get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), delete: call('DELETE') };
}
