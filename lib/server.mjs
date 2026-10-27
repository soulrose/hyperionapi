// `hyperion serve` — local web UI on 127.0.0.1. Same engine as the CLI.
import http from 'node:http';
import { readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { printSchema } from 'graphql';
import { loadProject, loadEnv, listRequestFiles, loadRequest, loadCollectionFor, forgetCollections, exists, readYaml, saveLocalEnvVars } from './project.mjs';
import { createVars } from './vars.mjs';
import { runRequest, operationType } from './runner.mjs';
import { syncSchema, loadSchema, validateQuery, forgetSchemas } from './schema.mjs';
import { resolveAuth, applyAuth, getToken, tokenState, clearToken, keycloakAuth, collectionAuth } from './auth.mjs';
import { complete } from './complete.mjs';
import { parse } from 'graphql';
import { interpolate } from './vars.mjs';
import { importPostman } from './import-postman.mjs';
import { listCollections, createCollection, createRequest, moveRequest, splitFolder } from './scaffold.mjs';
import { mkdir } from 'node:fs/promises';
import { forgetSchemas as clearSchemaMemo } from './schema.mjs';
import { listProjects, rememberProject, forgetProject } from './projects.mjs';
import { init, ENVS } from './init.mjs';
import { openWindow, trackPages, saveWindowBounds } from './app-window.mjs';
import { fieldsAt, roots, toggleField, toggleAll, toggleArg, selectedPaths } from './builder.mjs';
import { listFlows, createFlow, runFlow } from './flow.mjs';
import { exportBundle, importBundle, exportProject, importProject } from './bundle.mjs';
import { importPaste } from './import-paste.mjs';
import { scanPostmanDesktop, importPostmanDesktop, postmanCollectionVariables } from './import-postman-desktop.mjs';
import { RT_KINDS, getSession, closeSession, openWebSocket, openSocketIO } from './realtime.mjs';
import { describeProto, callGrpc, forgetProtos } from './grpc.mjs';
import { SOAP_FIELDS } from './runner.mjs';
import { describeWsdl, preferredPort } from './wsdl.mjs';

// what a realtime request file keeps besides url / auth / headers
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const RT_FIELDS = ['message', 'event', 'ack', 'namespace', 'path', 'protocols', 'authPayload', 'proto', 'includeDirs', 'service', 'method', 'tls'];

// sidebar / flow label: WS, SIO, gRPC, SOAP, the REST method, or query / mutation
const opOf = (request) =>
  RT_KINDS[request.kind] ??
  (request.kind === 'SoapRequest' ? 'SOAP' : request.kind === 'HttpRequest' ? (request.method ?? 'GET').toUpperCase() : operationType(request.payload?.query ?? '', request.payload?.operationName));
const soapVersionOf = (v) => (String(v).trim() === '1.2' ? '1.2' : '1.1');
// kinds whose own url: wins, else the collection's (REST always has its own)
const OWN_OR_INHERITED_URL = (kind) => !!RT_KINDS[kind] || kind === 'SoapRequest';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// where "new project" puts folders by default: next to the app (D:\OffLab\hyperion-projects), or HYPERION_HOME
const PROJECTS_HOME = path.resolve(process.env.HYPERION_HOME ?? path.join(PUBLIC, '..', '..', 'hyperion-projects'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

/**
 * dir: open this project (otherwise the last one used). registry: remember projects in ~/.hyperion
 * (the demo turns this off so its throwaway folder never shows up in the list).
 */
export async function serve({ dir, port = 4321, open = false, registry = true }) {
  let project = null;
  async function openProject(root) {
    if (!(await exists(path.join(root, 'hyperion.yaml')))) {
      throw Object.assign(new Error(`hyperion.yaml not found in ${root} — use "New project" instead`), { status: 400 });
    }
    project = await loadProject(root);
    sessions.clear();
    forgetCollections();
    clearSchemaMemo();
    if (registry) await rememberProject(project.root);
    return project;
  }
  // per-env runtime + flow scope that survives between Sends ($env.set / $flow.set)
  const sessions = new Map();
  const session = (envName) => {
    if (!sessions.has(envName)) sessions.set(envName, { runtime: {}, flow: {} });
    return sessions.get(envName);
  };
  if (dir) await openProject(path.resolve(dir));
  else if (registry) {
    const { last } = await listProjects();
    if (last) await openProject(last).catch(() => {});
  }

  const inProject = (rel) => {
    const full = path.resolve(project.root, rel ?? '');
    if (!full.startsWith(project.root + path.sep)) throw Object.assign(new Error('path outside project'), { status: 400 });
    return full;
  };

  async function context(file, envName) {
    const env = await loadEnv(project, envName);
    const collection = await loadCollectionFor(file);
    const s = session(env.name);
    const vars = createVars({ global: project.config.variables, collection: collection.config.variables, env, runtime: s.runtime, flow: s.flow, secrets: project.secrets });
    return { project, env, collection, vars, saveToken: true, plane: 'execution' };
  }

  // opened as an app window (start.bat / --open): stop when the last window closes, so nothing lingers
  const pages = open
    ? trackPages((why) => {
        console.log(`${why}: stopping hyperion`);
        process.exit(0);
      })
    : { ping() {}, bye() {} };

  const projectRoutes = {
    'GET /api/ping': async (q) => (pages.ping(q.p), { ok: true }),
    'POST /api/bye': async (_, body) => (pages.bye(body.p), { ok: true }),
    // the app window's size / position, used the next time it opens
    'POST /api/window': async (_, body) => ({ saved: open ? await saveWindowBounds(body) : false }),
    'GET /api/about': async () => ({ name: 'Hyperion API', version: VERSION, dev: 'soulrose', node: process.version }),

    'GET /api/projects': async () => ({ ...(registry ? await listProjects() : { projects: [] }), current: project?.root ?? null, registry, home: PROJECTS_HOME, sep: path.sep }),

    'POST /api/project/open': async (_, body) => {
      const p = await openProject(path.resolve(String(body.root ?? '').trim()));
      return { root: p.root };
    },

    'POST /api/project/new': async (_, body) => {
      const root = path.resolve(String(body.root ?? '').trim());
      if (!body.root?.trim()) throw Object.assign(new Error('Enter the folder path'), { status: 400 });
      await mkdir(root, { recursive: true });
      const created = await init(root, { name: body.name });
      await openProject(root);
      return { root, created };
    },

    // a project export (*.hyperion.json) → a new project folder, then open it
    'POST /api/project/import': async (_, body) => {
      const root = path.resolve(String(body.root ?? '').trim());
      if (!body.root?.trim()) throw Object.assign(new Error('Enter the folder path'), { status: 400 });
      const result = await importProject(root, body.bundle);
      await openProject(root);
      return { root, ...result };
    },

    'POST /api/project/forget': async (_, body) => {
      if (registry) await forgetProject(body.root);
      return { ok: true };
    },
  };

  const routes = {
    'GET /api/tree': async () => {
      forgetCollections();
      const envDir = path.join(project.root, 'envs');
      const envNames = (await readdir(envDir)).filter((f) => f.endsWith('.env.yaml') && !f.endsWith('.local.env.yaml')).map((f) => f.replace('.env.yaml', ''));
      // dev → test → prod → training first, anything else after
      const rank = (n) => (ENVS.includes(n) ? ENVS.indexOf(n) : ENVS.length);
      envNames.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
      const envs = await Promise.all(envNames.map(async (n) => {
        const e = await loadEnv(project, n);
        return { name: n, title: e.title, protected: e.protected };
      }));
      const collectionsDir = path.join(project.root, 'collections');
      const files = (await exists(collectionsDir)) ? await listRequestFiles([collectionsDir]) : [];
      const requests = await Promise.all(files.map(async (f) => {
        const { request, collection } = await loadRequest(f);
        const q = request.payload?.query ?? '';
        return {
          file: path.relative(project.root, f).replaceAll('\\', '/'),
          name: request.metadata?.name ?? path.basename(f, '.req.yaml'),
          collection: collection.config.metadata?.name ?? path.basename(collection.dir),
          collectionDir: path.relative(project.root, collection.dir).replaceAll(path.sep, '/'),
          kind: request.kind ?? 'GraphQLRequest',
          op: opOf(request),
        };
      }));
      const collections = await listCollections(project);
      const flows = await listFlows(project);
      return { name: project.config.name ?? path.basename(project.root), defaultEnv: project.config.defaultEnv ?? envs[0]?.name, envs, collections, requests, flows };
    },

    'GET /api/request': async (q) => {
      const file = inProject(q.file);
      const { request, collection, folders } = await loadRequest(file);
      const inherited = request.execution?.url ?? [...folders].reverse().find((f) => f.execution?.url)?.execution.url ?? collection.config.execution?.url;
      // REST keeps its own URL; a realtime request has its own or the collection's (e.g. {{WS_URL}})
      const url = request.kind === 'HttpRequest' ? request.url : OWN_OR_INHERITED_URL(request.kind) ? request.url ?? inherited : inherited;
      let resolvedUrl = url;
      let urlVar = null;
      let hostVar = null;
      if (q.env) {
        const ctx = await context(file, q.env);
        resolvedUrl = interpolate(url ?? '', ctx.vars);
        // URL is exactly one {{VAR}}: the URL bar edits that env variable
        const m = String(url ?? '').trim().match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
        if (m) urlVar = { name: m[1], value: ctx.env.variables[m[1]] == null ? '' : String(ctx.env.variables[m[1]]) };
        // REST: {{VAR}}/path follows the env; http://host/path does not
        const h = request.kind === 'HttpRequest' && !m && String(url ?? '').trim().match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/);
        if (h) {
          hostVar = { name: h[1], value: ctx.env.variables[h[1]] == null ? '' : String(ctx.env.variables[h[1]]) };
          // what the protected env (prod) uses, shown beside the URL whichever env is picked
          for (const n of await listEnvNames()) {
            const e = await loadEnv(project, n);
            if (!e.protected) continue;
            hostVar.prod = { env: e.title ?? n, value: e.variables[h[1]] == null ? '' : String(e.variables[h[1]]) };
            break;
          }
        }
      }
      const fixedHost = request.kind === 'HttpRequest' ? originOf(url) : null;
      return {
        op: RT_KINDS[request.kind] || request.kind === 'HttpRequest' || request.kind === 'SoapRequest' ? null : operationType(request.payload?.query ?? '', request.payload?.operationName),
        body: request.body,
        rt: RT_KINDS[request.kind] ? Object.fromEntries(RT_FIELDS.filter((k) => request[k] != null).map((k) => [k, request[k]])) : null,
        // SoapRequest: soapVersion / action / envelope / wsdl / operation (missing ones left out)
        ...(request.kind === 'SoapRequest' && {
          soap: Object.fromEntries(SOAP_FIELDS.filter((k) => request[k] != null).map((k) => [k, k === 'soapVersion' ? soapVersionOf(request[k]) : String(request[k])])),
        }),
        resolvedUrl,
        urlVar,
        hostVar,
        fixedHost,
        file: q.file,
        name: request.metadata?.name ?? path.basename(file, '.req.yaml'),
        kind: request.kind ?? 'GraphQLRequest',
        operationName: request.payload?.operationName ?? null,
        query: request.payload?.query ?? '',
        variables: request.payload?.variables ?? {},
        scripts: request.scripts ?? {},
        // the request's own auth/headers (Authorization / Headers tabs) and what it inherits otherwise
        auth: request.execution?.auth ?? request.auth ?? 'inherit',
        headers: Object.fromEntries(Object.entries(request.execution?.headers ?? request.headers ?? {}).map(([k, v]) => [k, String(v ?? '')])),
        inheritedAuth: resolveAuth(collectionAuth(collection.config, q.env), ...folders.map((f) => f.execution?.auth ?? f.auth))?.type ?? 'none',
        inheritedHeaders: Object.fromEntries(
          Object.entries(Object.assign({}, collection.config.execution?.headers, ...folders.map((f) => f.execution?.headers ?? f.headers))).map(([k, v]) => [k, String(v ?? '')]),
        ),
        method: (request.method ?? 'GET').toUpperCase(),
        url,
        maskFields: collection.config.masking?.fields ?? [],
        schemaMode: collection.config.schemaDiscovery?.mode ?? 'AUTO_FALLBACK',
      };
    },

    'POST /api/run': async (_, body) => {
      const file = inProject(body.file);
      const env = await loadEnv(project, body.env);
      const s = session(env.name);
      const logs = [];
      const result = await runRequest(file, {
        project, env, runtime: s.runtime, flow: s.flow, saveToken: true, confirm: body.confirm,
        override: { query: body.query, variables: body.variables, auth: body.auth, headers: body.headers, scripts: body.scripts, soap: body.soap },
        log: (m) => logs.push(m),
      });
      return { ...result, logs, flow: s.flow };
    },

    'POST /api/save': async (_, body) => {
      const file = inProject(body.file);
      const doc = YAML.parseDocument(await readFile(file, 'utf8'));
      if (body.query != null) doc.setIn(['payload', 'query'], body.query.endsWith('\n') ? body.query : `${body.query}\n`);
      if (body.variables != null) doc.setIn(['payload', 'variables'], body.variables);
      const kind = doc.get('kind') ?? 'GraphQLRequest';
      // rename = the display name only; the file keeps its name so flows pointing at it still work
      if (body.name != null && String(body.name).trim()) doc.setIn(['metadata', 'name'], String(body.name).trim());
      if (body.url != null) doc.setIn(kind === 'GraphQLRequest' ? ['execution', 'url'] : ['url'], body.url);
      // realtime requests: message, event, proto, service, method, ... at the top level ('' / null removes one)
      if (RT_KINDS[kind] && body.rt) {
        for (const k of RT_FIELDS) {
          if (!(k in body.rt)) continue;
          const v = body.rt[k];
          if (v == null || v === '' || v === false) doc.has(k) && doc.delete(k);
          else doc.set(k, v);
        }
      }
      // SOAP requests: soapVersion, action, envelope, wsdl, operation at the top level ('' / null removes one)
      if (kind === 'SoapRequest' && body.soap) {
        for (const k of SOAP_FIELDS) {
          if (!(k in body.soap)) continue;
          let v = body.soap[k];
          if (v == null || v === '') {
            if (doc.has(k)) doc.delete(k);
            continue;
          }
          v = k === 'soapVersion' ? soapVersionOf(v) : String(v);
          if (k === 'envelope' && !v.endsWith('\n')) v += '\n';
          doc.set(k, v);
        }
      }
      // GraphQL requests keep auth/headers under execution:, REST / SOAP requests at the top (where the importer puts them)
      const where = (key) => (['HttpRequest', 'SoapRequest'].includes(doc.get('kind')) || doc.has(key) ? [key] : ['execution', key]);
      // deleteIn throws when a parent (execution:) is missing — nothing to delete then
      const drop = (p) => doc.hasIn(p) && doc.deleteIn(p);
      if (body.auth !== undefined) {
        if (body.auth === 'inherit') drop(where('auth'));
        else doc.setIn(where('auth'), body.auth);
      }
      if (body.headers !== undefined) {
        if (Object.keys(body.headers).length) doc.setIn(where('headers'), body.headers);
        else drop(where('headers'));
      }
      // Scripts tab: beforeRequest / afterResponse (an empty box removes it)
      if (body.scripts !== undefined) {
        for (const k of ['beforeRequest', 'afterResponse']) {
          const code = String(body.scripts?.[k] ?? '');
          if (code.trim()) doc.setIn(['scripts', k], code.endsWith('\n') ? code : `${code}\n`);
          else drop(['scripts', k]);
        }
        if (doc.has('scripts') && !doc.get('scripts')?.items?.length) doc.delete('scripts');
      }
      if (doc.has('execution') && !doc.get('execution')?.items?.length) doc.delete('execution');
      await writeFile(file, doc.toString({ blockQuote: 'literal' }), 'utf8');
      return { saved: true };
    },

    'GET /api/schema': async (q) => {
      const ctx = await context(inProject(q.file), q.env);
      const s = await loadSchema(ctx);
      return s ? { meta: s.meta, sdl: q.sdl ? printSchema(s.schema) : undefined } : { meta: null };
    },

    'POST /api/schema/sync': async (_, body) => {
      forgetSchemas();
      const file = inProject(body.file);
      const ctx = await context(file, body.env);
      const logs = [];
      // the open request's own token / headers (as edited, else as saved) also count when reading the schema
      const { request, folders } = await loadRequest(file);
      const targetAuth = body.auth !== undefined ? body.auth : resolveAuth(...folders.map((f) => f.execution?.auth ?? f.auth), request.execution?.auth ?? request.auth) ?? undefined;
      const targetHeaders = body.headers ?? Object.assign({}, ...folders.map((f) => f.execution?.headers ?? f.headers ?? {}), request.execution?.headers ?? request.headers ?? {});
      try {
        const { meta } = await syncSchema({ ...ctx, log: (m) => logs.push(m) }, { snapshot: body.snapshot, reprobe: body.reprobe, targetAuth: targetAuth === 'inherit' ? undefined : targetAuth, targetHeaders });
        return { meta, logs };
      } catch (err) {
        return { error: err.message, logs };
      }
    },

    'POST /api/complete': async (_, body) => {
      const ctx = await context(inProject(body.file), body.env);
      const s = await loadSchema(ctx);
      if (!s) return { items: [], noSchema: true };
      return complete(s.schema, body.query, body.offset);
    },

    'POST /api/validate': async (_, body) => {
      const ctx = await context(inProject(body.file), body.env);
      const s = await loadSchema(ctx);
      if (!s) {
        try {
          parse(body.query);
          return { errors: [], noSchema: true };
        } catch (err) {
          return { errors: [err.message], noSchema: true };
        }
      }
      return { errors: validateQuery(s.schema, body.query) };
    },

    'POST /api/collection': async (_, body) => {
      const c = await createCollection(project, body);
      forgetCollections();
      return c;
    },

    'POST /api/request/new': async (_, body) => ({ file: await createRequest(project, body) }),

    // ---- realtime: WebSocket / Socket.IO sessions and gRPC calls; the UI follows a session over /api/rt/events
    'POST /api/rt/start': async (_, body) => {
      const p = await rtPrepare(body);
      if (p.kind === 'GrpcRequest') {
        if (!p.rt.service || !p.rt.method) throw bad('Choose a service / method first');
        const r = await callGrpc({ ...p.grpc, service: p.rt.service, method: p.rt.method, message: p.json(p.rt.message, 'Message'), headers: p.headers });
        return r.session ? { id: r.session.id, streaming: r.streaming } : { result: r };
      }
      const s =
        p.kind === 'SocketIORequest'
          ? openSocketIO({ url: p.url, path: p.rt.path || undefined, namespace: p.rt.namespace || '/', auth: p.sioAuth(), headers: p.headers })
          : openWebSocket({ url: p.url, headers: p.headers, protocols: [].concat(p.rt.protocols ?? []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean) });
      return { id: s.id };
    },

    'POST /api/rt/send': async (_, body) => {
      const s = getSession(body.id);
      if (!s) throw bad('This connection is already closed — press Connect again');
      const ctx = await context(inProject(body.file), body.env);
      const text = interpolate(String(body.message ?? ''), ctx.vars);
      if (s.kind === 'socketio') s.emit(body.event || 'message', sioArgs(text), !!body.ack);
      else if (s.kind === 'grpc') s.send(parseJson(text, 'Message'));
      else s.send(text);
      return { ok: true };
    },

    'POST /api/rt/close': async (_, body) => ({ closed: closeSession(body.id) }),

    // services / methods of the request's .proto (with an example message for each method)
    'GET /api/grpc/describe': async (q) => {
      if (q.reload) forgetProtos();
      const file = inProject(q.file);
      const { request } = await loadRequest(file);
      const ctx = await context(file, q.env);
      const proto = interpolate(String(q.proto ?? request.proto ?? '').trim(), ctx.vars);
      if (!proto) throw bad('Enter the .proto file path first');
      const includeDirs = [].concat(request.includeDirs ?? []).flatMap((d) => String(d).split(';')).filter(Boolean).map((d) => path.resolve(project.root, d));
      return { services: await describeProto(path.resolve(project.root, proto), includeDirs) };
    },

    // ---- SOAP: services / ports / operations of a WSDL (each with a sample envelope), and import as requests
    'GET /api/soap/wsdl': async (q) => {
      const file = q.file ? inProject(q.file) : null;
      const wsdl = q.wsdl ?? (file ? (await loadRequest(file)).request.wsdl : undefined);
      const d = await soapDescribe(file, q.env, wsdl);
      return { services: d.services, notes: d.notes };
    },

    'POST /api/soap/import': async (_, body) => {
      if (!body.collection) throw bad('Choose a collection to import into');
      const colDir = inProject(body.collection);
      const colFile = path.join(colDir, '_collection.yaml');
      if (!(await exists(colFile))) throw bad('Not a collection');
      const env = await loadEnv(project, body.env);
      const wsdl = String(body.wsdl ?? '').trim();
      const d = await soapDescribe(colDir, env.name, wsdl);
      const { service, port } = preferredPort(d.services);
      const files = [];
      for (const op of port.operations) {
        files.push(
          await createRequest(project, {
            collection: path.relative(project.root, colDir).replaceAll(path.sep, '/'),
            folder: body.folder ?? '',
            name: op.name,
            kind: 'SoapRequest',
            soap: { soapVersion: port.soapVersion, action: op.action, envelope: op.envelope, operation: op.name, wsdl },
          }),
        );
      }
      // the requests inherit the collection URL: give the collection {{SOAP_URL}} if it has none,
      // and set that variable to the port's address when this env has no value yet
      const doc = YAML.parseDocument(await readFile(colFile, 'utf8'));
      let colUrl = doc.getIn(['execution', 'url']);
      if (!colUrl) {
        colUrl = '{{SOAP_URL}}';
        doc.setIn(['execution', 'url'], colUrl);
        await writeFile(colFile, doc.toString({ lineWidth: 0 }), 'utf8');
      }
      const m = String(colUrl).trim().match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
      let urlVar = null;
      if (m && port.address && (env.variables[m[1]] == null || env.variables[m[1]] === '')) {
        const envDoc = YAML.parseDocument(await readFile(env.file, 'utf8'));
        envDoc.setIn(['variables', m[1]], port.address);
        await writeFile(env.file, envDoc.toString({ lineWidth: 0 }), 'utf8');
        urlVar = { name: m[1], env: env.name, value: port.address };
      }
      forgetCollections();
      return { count: files.length, files, service: service.name, port: port.name, soapVersion: port.soapVersion, address: port.address, urlVar, notes: d.notes };
    },

    'POST /api/request/move': async (_, body) => {
      const file = await moveRequest(project, body);
      forgetCollections();
      return { file };
    },

    'POST /api/collection/split': async (_, body) => {
      const r = await splitFolder(project, body);
      forgetCollections();
      forgetSchemas();
      return r;
    },

    // Postman desktop's local store: GraphQL requests (which Postman's export leaves out) and REST requests
    'GET /api/import/postman-desktop': async () => {
      const s = await scanPostmanDesktop();
      return {
        stores: s.stores,
        collections: s.collections.map((c) => ({ id: c.id, name: c.name, graphql: c.requests.length, rest: c.rest.length, requests: c.requests.length + c.rest.length, namesOnly: c.namesOnly })),
      };
    },

    'POST /api/import/postman-desktop': async (_, body) => {
      const report = await importPostmanDesktop(project, { ids: body.ids, envName: body.env });
      forgetCollections();
      return { report };
    },

    'POST /api/import/paste': async (_, body) => {
      const r = await importPaste(project, { text: body.text, collection: body.collection, name: body.name, envName: body.env });
      forgetCollections();
      return r;
    },

    'POST /api/import': async (_, body) => {
      const r = await importPostman(project, body.json, { fileName: body.name });
      forgetCollections();
      return r;
    },

    'GET /api/token': async (q) => tokenInfo(await context(inProject(q.file), q.env)),

    // flows: flows/*.flow.yaml — blocks that run requests in order
    'GET /api/flow': async (q) => {
      const file = inProject(q.file);
      const doc = await readYaml(file);
      const steps = await Promise.all((doc.steps ?? []).map(async (s) => {
        const reqFile = path.resolve(project.root, s.request ?? '');
        if (!s.request || !(await exists(reqFile))) return { ...s, missing: true, name: s.request ?? '?' };
        const { request, collection } = await loadRequest(reqFile);
        return {
          ...s,
          name: request.metadata?.name ?? path.basename(reqFile, '.req.yaml'),
          collection: collection.config.metadata?.name ?? path.basename(collection.dir),
          op: opOf(request),
        };
      }));
      return { file: q.file, name: doc.metadata?.name ?? path.basename(file, '.flow.yaml'), steps };
    },

    'POST /api/flow/new': async (_, body) => ({ file: await createFlow(project, body.name) }),

    // one *.hyperion.json: a request, or a flow with the requests it runs (+ collection settings, never secrets)
    'POST /api/export': async (_, body) => exportBundle(project, body.files),
    'GET /api/project/export': async () => exportProject(project),
    'POST /api/import/bundle': async (_, body) => {
      const result = await importBundle(project, body.bundle);
      forgetCollections();
      return result;
    },

    'POST /api/flow/save': async (_, body) => {
      const file = inProject(body.file);
      const doc = YAML.parseDocument(await readFile(file, 'utf8'));
      if (body.name) doc.setIn(['metadata', 'name'], body.name);
      // keep only what the file format stores
      doc.set('steps', (body.steps ?? []).map((s) => Object.fromEntries(Object.entries({ request: s.request, when: s.when || undefined, continueOnFail: s.continueOnFail || undefined }).filter(([, v]) => v !== undefined))));
      await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8');
      return { saved: true };
    },

    'POST /api/flow/delete': async (_, body) => {
      await rm(inProject(body.file), { force: true });
      return { deleted: true };
    },

    'POST /api/flow/run': async (_, body) => {
      const env = await loadEnv(project, body.env);
      const logs = [];
      const r = await runFlow(project, body.file, { env, runtime: session(env.name).runtime, saveToken: true, log: (m) => logs.push(m), confirm: true });
      return { ...r, logs };
    },

    // schema explorer: one level of fields, and tick/untick a field in the query
    'GET /api/explorer': async (q) => {
      const s = await loadSchema(await context(inProject(q.file), q.env));
      if (!s) return { noSchema: true };
      const path = q.path ? q.path.split('.') : [];
      return { roots: roots(s.schema), fields: fieldsAt(s.schema, q.op || 'query', path) };
    },

    'POST /api/explorer/toggle': async (_, body) => {
      const s = await loadSchema(await context(inProject(body.file), body.env));
      if (!s) throw Object.assign(new Error('No schema yet — press Sync schema first'), { status: 409 });
      const r = toggleField(s.schema, body.query ?? '', body.op || 'query', body.path ?? [], !!body.on);
      return { ...r, selected: selectedPaths(r.query).paths };
    },

    'POST /api/explorer/selected': async (_, body) => selectedPaths(body.query ?? ''),

    'POST /api/explorer/toggle-all': async (_, body) => {
      const s = await loadSchema(await context(inProject(body.file), body.env));
      if (!s) throw Object.assign(new Error('No schema yet'), { status: 409 });
      const r = toggleAll(s.schema, body.query ?? '', body.op || 'query', body.path ?? [], !!body.on);
      return { ...r, ...selectedPaths(r.query) };
    },

    // pass / stop passing an argument as a $variable (inputs in the schema panel)
    'POST /api/explorer/arg': async (_, body) => {
      const s = await loadSchema(await context(inProject(body.file), body.env));
      if (!s) throw Object.assign(new Error('No schema yet'), { status: 409 });
      const r = toggleArg(s.schema, body.query ?? '', body.op || 'query', body.path ?? [], body.arg, !!body.on);
      return { ...r, ...selectedPaths(r.query) };
    },

    // delete = move to .hyperion/trash/ (gitignored, can be moved back); say which flows used its requests
    'POST /api/collection/delete': async (_, body) => {
      const dir = inProject(body.dir);
      if (!dir.startsWith(path.join(project.root, 'collections') + path.sep) || !(await exists(path.join(dir, '_collection.yaml')))) {
        throw Object.assign(new Error('Not a collection'), { status: 400 });
      }
      const rel = path.relative(project.root, dir).replaceAll(path.sep, '/');
      const files = await listRequestFiles([dir]);
      const flowsUsing = [];
      for (const f of await listFlows(project)) {
        const doc = await readYaml(path.join(project.root, f.file)).catch(() => ({}));
        if ((doc.steps ?? []).some((s) => String(s.request ?? '').startsWith(`${rel}/`))) flowsUsing.push(f.name);
      }
      const trash = path.join(project.root, '.hyperion', 'trash', `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(dir)}`);
      await mkdir(path.dirname(trash), { recursive: true });
      await rename(dir, trash);
      forgetCollections();
      forgetSchemas();
      return { deleted: rel, requests: files.length, trash: path.relative(project.root, trash).replaceAll(path.sep, '/'), flowsUsing };
    },

    // fixed hosts in REST requests (http://host:port written into the URL): which ones and how many requests each
    'GET /api/hosts': async () => {
      const counts = new Map();
      for (const f of await listRequestFiles([path.join(project.root, 'collections')])) {
        const o = originOf((await readYaml(f).catch(() => ({}))).url);
        if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
      }
      return { hosts: [...counts].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count) };
    },

    // hosts → one env variable: every REST URL starting with one of them becomes {{NAME}}/path;
    // the env in use gets `value`, other envs get what was typed for them (left out when empty)
    'POST /api/host/to-var': async (_, body) => {
      const name = String(body.name ?? '').trim();
      if (!/^[A-Za-z_][\w]*$/.test(name)) throw bad('Variable names may only use A-Z 0-9 _');
      const hosts = [].concat(body.hosts ?? []).map(String).filter(Boolean);
      if (!hosts.length) throw bad('No host selected');
      let changed = 0;
      for (const f of await listRequestFiles([path.join(project.root, 'collections')])) {
        const doc = YAML.parseDocument(await readFile(f, 'utf8'));
        const url = doc.get('url');
        const o = originOf(url);
        if (!o || !hosts.includes(o)) continue;
        doc.set('url', `{{${name}}}${String(url).trim().replace(/^"|"$/g, '').slice(o.length)}`);
        await writeFile(f, doc.toString({ blockQuote: 'literal', lineWidth: 0 }), 'utf8');
        changed++;
      }
      const values = { ...(body.values ?? {}), [body.env]: body.value };
      for (const [envName, v] of Object.entries(values)) {
        const value = String(v ?? '').trim().replace(/\/+$/, '');
        if (!value) continue;
        const env = await loadEnv(project, envName);
        const envDoc = YAML.parseDocument(await readFile(env.file, 'utf8'));
        envDoc.setIn(['variables', name], value);
        await writeFile(env.file, envDoc.toString({ lineWidth: 0 }), 'utf8');
      }
      forgetCollections();
      return { changed, name };
    },

    // one request file → .hyperion/trash (restorable); says which flows still point at it
    'POST /api/request/delete': async (_, body) => {
      const file = inProject(body.file);
      if (!file.startsWith(path.join(project.root, 'collections') + path.sep) || !file.endsWith('.req.yaml') || !(await exists(file))) {
        throw Object.assign(new Error('Not a request file'), { status: 400 });
      }
      const rel = path.relative(project.root, file).replaceAll(path.sep, '/');
      const flowsUsing = [];
      for (const f of await listFlows(project)) {
        const doc = await readYaml(path.join(project.root, f.file)).catch(() => ({}));
        if ((doc.steps ?? []).some((s) => s.request === rel)) flowsUsing.push(f.name);
      }
      const trash = path.join(project.root, '.hyperion', 'trash', `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(file)}`);
      await mkdir(path.dirname(trash), { recursive: true });
      await rename(file, trash);
      return { deleted: rel, trash: path.relative(project.root, trash).replaceAll(path.sep, '/'), flowsUsing };
    },

    // Keycloak / OpenID login for a collection: auth in _collection.yaml, URL / client / user in the env,
    // password and client secret in secrets.local.yaml (per env)
    'GET /api/auth/keycloak': async (q) => {
      const env = await loadEnv(project, q.env);
      const v = env.variables;
      const P = env.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      return {
        env: env.name,
        tokenUrl: v.KC_TOKEN_URL ?? '',
        clientId: v.KC_CLIENT_ID ?? '',
        username: v.KC_USERNAME ?? '',
        hasPassword: project.secrets.has(`${P}_KC_PASSWORD`),
        hasClientSecret: project.secrets.has(`${P}_KC_CLIENT_SECRET`),
      };
    },

    'POST /api/auth/keycloak': async (_, body) => {
      const colFile = path.join(inProject(body.dir), '_collection.yaml');
      const env = await loadEnv(project, body.env);
      const P = env.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      // secrets: an empty box means "keep what is stored"
      if (body.password) await project.secrets.set(`${P}_KC_PASSWORD`, body.password);
      if (body.clientSecret) await project.secrets.set(`${P}_KC_CLIENT_SECRET`, body.clientSecret);
      const envDoc = YAML.parseDocument(await readFile(env.file, 'utf8'));
      const vars = {
        KC_TOKEN_URL: String(body.tokenUrl ?? '').trim(),
        KC_CLIENT_ID: String(body.clientId ?? '').trim(),
        KC_USERNAME: String(body.username ?? '').trim(),
        KC_PASSWORD: `{{secret:${P}_KC_PASSWORD}}`,
        // optional: an empty string is left out of the form
        KC_CLIENT_SECRET: project.secrets.has(`${P}_KC_CLIENT_SECRET`) ? `{{secret:${P}_KC_CLIENT_SECRET}}` : '',
      };
      for (const [k, v] of Object.entries(vars)) envDoc.setIn(['variables', k], v);
      await writeFile(env.file, envDoc.toString({ lineWidth: 0 }), 'utf8');
      const colDoc = YAML.parseDocument(await readFile(colFile, 'utf8'));
      await setCollectionAuth(body.dir, colDoc, env.name, keycloakAuth(), body.scope);
      await writeFile(colFile, colDoc.toString({ lineWidth: 0 }), 'utf8');
      forgetCollections();
      // new credentials: drop the token kept for this env (file and memory) so the next send logs in with them
      await saveLocalEnvVars(env, { ACCESS_TOKEN: null, REFRESH_TOKEN: null, TOKEN_EXPIRES_AT: null });
      for (const k of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'TOKEN_EXPIRES_AT']) delete session(env.name).runtime[k];
      return { saved: true };
    },

    // collection settings: URL, auth and headers in _collection.yaml (comments kept)
    'GET /api/collection/settings': async (q) => {
      const dir = inProject(q.dir);
      const c = await readYaml(path.join(dir, '_collection.yaml'));
      const ex = c.execution ?? {};
      const stash = (await readStash())[q.dir] ?? {};
      return {
        dir: q.dir,
        name: c.metadata?.name ?? path.basename(dir),
        type: c.type ?? null,
        url: ex.url ?? '',
        // the auth this env uses; ownAuth = this env has its own (execution.authByEnv), others = what the other envs use
        auth: collectionAuth(c, q.env) ?? 'none',
        ownAuth: !!(q.env && ex.authByEnv?.[q.env]),
        others: Object.fromEntries(
          (await listEnvNames()).filter((e) => e !== q.env).map((e) => [e, authKind(collectionAuth(c, e))]),
        ),
        stash,
        headers: Object.fromEntries(Object.entries(ex.headers ?? {}).map(([k, v]) => [k, String(v ?? '')])),
        variables: Object.fromEntries(Object.entries(c.variables ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)])),
      };
    },

    // the collection's variables from Postman desktop (current values), secrets moved to secrets.local.yaml
    'POST /api/collection/vars/postman': async (_, body) => {
      const file = path.join(inProject(body.dir), '_collection.yaml');
      const doc = YAML.parseDocument(await readFile(file, 'utf8'));
      const name = doc.getIn(['metadata', 'name']) ?? path.basename(path.dirname(file));
      const pm = await postmanCollectionVariables(name);
      if (!pm.found) throw bad(pm.stores ? `Collection "${name}" not found in Postman desktop` : 'No Postman desktop data found on this machine');
      const vars = { ...(doc.toJS().variables ?? {}) };
      for (const v of pm.variables) vars[v.key] = v.value;
      const moved = await writeCollectionVars(body.dir, doc, vars);
      await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8');
      forgetCollections();
      return { count: pm.variables.length, current: pm.hasCurrent, secrets: moved };
    },

    'POST /api/collection/settings': async (_, body) => {
      const file = path.join(inProject(body.dir), '_collection.yaml');
      const doc = YAML.parseDocument(await readFile(file, 'utf8'));
      // rename = the display name only; the folder keeps its name so flows pointing at its requests still work
      if (body.name != null && String(body.name).trim()) doc.setIn(['metadata', 'name'], String(body.name).trim());
      if (['graphql', 'rest', 'grpc', 'websocket', 'soap'].includes(body.type)) doc.set('type', body.type);
      if (body.variables != null) await writeCollectionVars(body.dir, doc, body.variables);
      if (body.url != null) {
        if (body.url.trim()) doc.setIn(['execution', 'url'], body.url.trim());
        else doc.deleteIn(['execution', 'url']);
      }
      if (body.auth != null) await setCollectionAuth(body.dir, doc, body.env, body.auth, body.scope);
      if (body.headers != null) {
        if (Object.keys(body.headers).length) doc.setIn(['execution', 'headers'], body.headers);
        else doc.deleteIn(['execution', 'headers']);
      }
      await writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8');
      forgetCollections();
      return { saved: true };
    },

    // env editor: reads/writes envs/<env>.env.yaml in place, keeping its comments
    'GET /api/env': async (q) => {
      const env = await loadEnv(project, q.env);
      return {
        name: env.name,
        title: env.title,
        protected: env.protected,
        file: path.relative(project.root, env.file).replaceAll(path.sep, '/'),
        variables: Object.fromEntries(Object.entries(env.variables).map(([k, v]) => [k, v == null ? '' : String(v)])),
      };
    },

    // a pasted token: kept in envs/<env>.local.env.yaml (gitignored), never in a request / collection file
    'POST /api/env/local': async (_, body) => {
      if (!/^[A-Za-z_][\w.-]*$/.test(body.name ?? '')) throw Object.assign(new Error('Invalid variable name'), { status: 400 });
      const env = await loadEnv(project, body.env);
      await saveLocalEnvVars(env, { [body.name]: String(body.value ?? '') });
      delete session(env.name).runtime[body.name]; // an older value held in memory must not win
      return { saved: true, file: `envs/${env.name}.local.env.yaml` };
    },

    'GET /api/env/local': async (q) => {
      const env = await loadEnv(project, q.env);
      const v = env.localVariables[q.name];
      return { has: v != null && v !== '', preview: v ? `${String(v).slice(0, 12)}…` : '' };
    },

    // one variable, e.g. GQL_URL typed into the URL bar
    'POST /api/env/var': async (_, body) => {
      if (!/^[A-Za-z_][\w.-]*$/.test(body.name ?? '')) throw Object.assign(new Error('Invalid variable name'), { status: 400 });
      const env = await loadEnv(project, body.env);
      const doc = YAML.parseDocument(await readFile(env.file, 'utf8'));
      doc.setIn(['variables', body.name], await keepSecretOut(env, body.name, String(body.value ?? '')));
      await writeFile(env.file, doc.toString({ lineWidth: 0 }), 'utf8');
      forgetSchemas();
      return { saved: true };
    },

    'POST /api/env': async (_, body) => {
      const env = await loadEnv(project, body.env);
      const doc = YAML.parseDocument(await readFile(env.file, 'utf8'));
      const next = body.variables ?? {};
      for (const key of Object.keys(env.variables)) if (!Object.hasOwn(next, key)) doc.deleteIn(['variables', key]);
      for (const [k, raw] of Object.entries(next)) {
        if (!/^[A-Za-z_][\w.-]*$/.test(k)) throw Object.assign(new Error(`Invalid variable name: "${k}"`), { status: 400 });
        const v = await keepSecretOut(env, k, raw);
        if (doc.getIn(['variables', k]) !== v) doc.setIn(['variables', k], v);
      }
      if (typeof body.protected === 'boolean') doc.set('protected', body.protected);
      await writeFile(env.file, doc.toString({ lineWidth: 0 }), 'utf8');
      forgetSchemas();
      return { saved: true };
    },

    'POST /api/token': async (_, body) => {
      const ctx = await context(inProject(body.file), body.env);
      const cfg = tokenCfg(ctx);
      if (!cfg) return { kind: 'none' };
      const logs = [];
      try {
        if (body.action === 'clear') await clearToken(cfg, ctx);
        else if (body.action === 'login') {
          // a real login with the username / password (no refresh), so it proves the credentials
          await clearToken(cfg, ctx);
          await getToken(cfg, { ...ctx, log: (m) => logs.push(m) }, { force: true });
        } else await getToken(cfg, { ...ctx, log: (m) => logs.push(m) }, { force: true });
      } catch (err) {
        return { ...(await tokenInfo(ctx)), error: err.message, logs };
      }
      return { ...(await tokenInfo(await context(inProject(body.file), body.env))), logs };
    },
  };

  // env files may be committed: a typed password / secret / key / token goes to secrets.local.yaml instead,
  // and the env file keeps {{secret:<ENV>_<NAME>}}
  const SECRET_NAME = /pass(word)?|secret|api[_-]?key|private[_-]?key|(^|_)token$/i;
  async function keepSecretOut(env, name, value) {
    const v = String(value ?? '');
    if (!SECRET_NAME.test(name) || !v || /^\{\{.*\}\}$/.test(v.trim())) return v;
    const secretName = `${env.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    await project.secrets.set(secretName, v);
    return `{{secret:${secretName}}}`;
  }

  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  // "http://host:port" of a URL written out in full (null for {{VAR}}/... and relative URLs)
  const originOf = (url) => String(url ?? '').trim().replace(/^"/, '').match(/^https?:\/\/[^/?#\s"]+/i)?.[0] ?? null;
  const parseJson = (text, what) => {
    if (!String(text).trim()) return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      throw bad(`${what} must be JSON (${e.message})`);
    }
  };
  // Socket.IO arguments: a JSON array = several, any other JSON = one, plain text = one string
  const sioArgs = (text) => {
    if (!text.trim()) return [];
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v : [v];
    } catch {
      return [text];
    }
  };

  /** A realtime request ready to open: URL, headers and auth resolved for the env (unsaved edits in body win). */
  async function rtPrepare(body) {
    const file = inProject(body.file);
    const { request, collection, folders } = await loadRequest(file);
    const ctx = await context(file, body.env);
    const rt = { ...Object.fromEntries(RT_FIELDS.map((k) => [k, request[k]])), ...(body.rt ?? {}) };
    const need = (v, what) => {
      const missing = [];
      const out = interpolate(v, ctx.vars, missing);
      if (missing.length) throw bad(`${what} uses variables not set in env ${ctx.env.name}: ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')}`);
      return out;
    };
    const rawUrl = body.url ?? request.url ?? [...folders].reverse().find((f) => f.execution?.url)?.execution.url ?? collection.config.execution?.url ?? '';
    const url = need(String(rawUrl).trim(), 'URL');
    if (!url) throw bad('Enter a URL first');
    const headers = need(
      Object.assign({}, collection.config.execution?.headers, ...folders.map((f) => f.execution?.headers ?? f.headers ?? {}), body.headers ?? request.execution?.headers ?? request.headers ?? {}),
      'Headers',
    );
    const reqAuth = body.auth !== undefined ? body.auth : request.execution?.auth ?? request.auth;
    const auth = resolveAuth(collectionAuth(collection.config, ctx.env.name), ...folders.map((f) => f.execution?.auth ?? f.auth), reqAuth);
    // gRPC addresses have no scheme (host:port): give applyAuth a URL it can parse
    const req = { url: /^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`, headers };
    await applyAuth(auth, req, ctx);
    const proto = rt.proto ? path.resolve(project.root, need(String(rt.proto), '.proto')) : null;
    return {
      kind: request.kind,
      rt,
      url: req.url === `http://${url}` ? url : req.url,
      headers: req.headers,
      json: (v, what) => parseJson(need(typeof v === 'string' ? v : JSON.stringify(v ?? {}), what), what),
      // Socket.IO handshake auth: the request's own JSON, else the bearer token as { token }
      sioAuth: () => {
        if (rt.authPayload && String(rt.authPayload).trim()) return parseJson(need(String(rt.authPayload), 'Auth payload'), 'Auth payload');
        const bearer = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
        const m = String(bearer ?? '').match(/^Bearer\s+(.+)$/i);
        return m ? { token: m[1] } : undefined;
      },
      get grpc() {
        if (!proto) throw bad('Enter the .proto file path first');
        return {
        file: proto,
        includeDirs: [].concat(rt.includeDirs ?? []).flatMap((d) => String(d).split(';')).filter(Boolean).map((d) => path.resolve(project.root, d)),
        address: url,
        tls: !!rt.tls || /^grpcs:/i.test(url),
        };
      },
    };
  }

  /**
   * Describe a WSDL for a request file or a collection dir: {{variables}} resolved for the env, and a URL is fetched
   * with the collection's / folders' / request's headers and auth. A file path is relative to the project root.
   */
  async function soapDescribe(target, envName, wsdl) {
    // without a request / collection only the env's variables apply (no auth, no headers)
    let ctx;
    if (target) ctx = await context(target, envName);
    else {
      const env = await loadEnv(project, envName);
      const s = session(env.name);
      ctx = { project, env, collection: { config: {} }, vars: createVars({ global: project.config.variables, env, runtime: s.runtime, flow: s.flow, secrets: project.secrets }), saveToken: true, plane: 'execution' };
    }
    const isReq = target && String(target).endsWith('.req.yaml');
    const { request = {}, folders = [] } = isReq ? await loadRequest(target) : {};
    const missing = [];
    const source = String(interpolate(String(wsdl ?? '').trim(), ctx.vars, missing));
    if (!source) throw bad('Enter the WSDL URL or file path first');
    if (missing.length) throw bad(`WSDL uses variables not set in env ${ctx.env.name}: ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')}`);
    let req = { url: source, headers: {} };
    if (/^https?:\/\//i.test(source)) {
      const hm = [];
      const headers = interpolate(
        Object.assign({}, ctx.collection.config.execution?.headers, ...folders.map((f) => f.execution?.headers ?? f.headers ?? {}), request.execution?.headers ?? request.headers ?? {}),
        ctx.vars,
        hm,
      );
      req = { url: source, headers: hm.length ? {} : headers };
      const auth = resolveAuth(collectionAuth(ctx.collection.config, ctx.env.name), ...folders.map((f) => f.execution?.auth ?? f.auth), request.execution?.auth ?? request.auth);
      await applyAuth(auth, req, ctx).catch(() => {}); // a WSDL is often public: a login that fails must not hide it
    }
    try {
      return await describeWsdl(req.url, { headers: req.headers, baseDir: project.root });
    } catch (e) {
      throw bad(e.message);
    }
  }

  // collection variables are committed with the collection: a password / API key / token / cookie value goes to
  // secrets.local.yaml as <COLLECTION>_<NAME> and the file keeps {{secret:…}}. Returns the names moved.
  const COL_SECRET = /pass(word)?|secret|api[_-]?key|private[_-]?key|token$|cookie/i;
  async function writeCollectionVars(dir, doc, vars) {
    const prefix = path.basename(dir).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const out = {};
    const moved = [];
    for (const [k, raw] of Object.entries(vars ?? {})) {
      if (!k.trim()) continue;
      const v = raw == null ? '' : String(raw);
      if (COL_SECRET.test(k) && v && !/^\{\{.*\}\}$/.test(v.trim())) {
        const secretName = `${prefix}_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
        await project.secrets.set(secretName, v);
        out[k.trim()] = `{{secret:${secretName}}}`;
        moved.push(k.trim());
      } else out[k.trim()] = v;
    }
    if (Object.keys(out).length) doc.set('variables', out);
    else if (doc.has('variables')) doc.delete('variables');
    return moved;
  }

  // ---- collection auth per env: execution.auth is shared, execution.authByEnv.<env> is one env's own.
  // Changing it in one env never changes another: the first login set on a collection becomes the shared one,
  // later changes go to that env only (or to every env with scope "all").
  const authKind = (a) => (!a || a === 'none' || a.type === 'none' ? 'none' : a.type === 'tokenEndpoint' && a.tokenEndpoint?.kind === 'keycloak' ? 'keycloak' : a.type ?? 'none');
  const same = (a, b) => JSON.stringify(a ?? 'none') === JSON.stringify(b ?? 'none');
  const stashFile = () => path.join(project.root, '.hyperion', 'auth-stash.json');
  const readStash = async () => {
    try {
      return JSON.parse(await readFile(stashFile(), 'utf8'));
    } catch {
      return {};
    }
  };
  const listEnvNames = async () =>
    (await readdir(path.join(project.root, 'envs')).catch(() => [])).filter((n) => /^[^.]+\.env\.yaml$/.test(n)).map((n) => n.replace(/\.env\.yaml$/, ''));

  async function setCollectionAuth(dir, doc, envName, auth, scope) {
    const ex = doc.toJS()?.execution ?? {};
    const prev = envName ? (ex.authByEnv?.[envName] ?? ex.auth) : ex.auth;
    // remember what this env had, by kind, so switching back (Bearer → ไม่มี → Bearer) brings the values back
    if (prev && authKind(prev) !== 'none' && !same(prev, auth)) {
      const all = await readStash();
      all[dir] = { ...(all[dir] ?? {}), [authKind(prev)]: prev };
      await mkdir(path.dirname(stashFile()), { recursive: true });
      await writeFile(stashFile(), JSON.stringify(all, null, 2), 'utf8');
    }
    const shared = ex.auth ?? 'none';
    const overrides = ex.authByEnv ?? {};
    if (!envName || scope === 'all' || (authKind(shared) === 'none' && !Object.keys(overrides).length)) {
      doc.setIn(['execution', 'auth'], auth);
      if (scope === 'all' && doc.hasIn(['execution', 'authByEnv'])) doc.deleteIn(['execution', 'authByEnv']);
    } else if (same(auth, shared)) {
      if (doc.hasIn(['execution', 'authByEnv', envName])) doc.deleteIn(['execution', 'authByEnv', envName]);
    } else {
      doc.setIn(['execution', 'authByEnv', envName], auth);
    }
    if (doc.getIn(['execution', 'authByEnv']) && !Object.keys(doc.toJS().execution.authByEnv ?? {}).length) doc.deleteIn(['execution', 'authByEnv']);
  }

  function tokenCfg(ctx) {
    const auth = resolveAuth(collectionAuth(ctx.collection.config, ctx.env.name));
    return auth?.type === 'tokenEndpoint' ? auth.tokenEndpoint ?? auth : null;
  }

  async function tokenInfo(ctx) {
    const cfg = tokenCfg(ctx);
    if (!cfg) return { kind: resolveAuth(collectionAuth(ctx.collection.config, ctx.env.name))?.type ?? 'none' };
    const st = tokenState(cfg, ctx);
    return { kind: 'tokenEndpoint', hasToken: !!st.token, expiresAt: st.expMs ? new Date(st.expMs).toISOString() : null, hasRefresh: !!st.refreshToken, varName: st.names.accessToken };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const key = `${req.method} ${url.pathname}`;
      // live messages of a WebSocket / Socket.IO / gRPC-stream session (Server-Sent Events, history first)
      if (key === 'GET /api/rt/events') {
        const s = getSession(url.searchParams.get('id'));
        if (!s) return send(404, { error: 'Connection not found' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        for (const e of s.log) write(e);
        s.listeners.add(write);
        req.on('close', () => s.listeners.delete(write));
        return;
      }
      if (routes[key] && !project) {
        if (key === 'GET /api/tree') return send(200, { noProject: true });
        return send(409, { error: 'No project is open' });
      }
      const route = projectRoutes[key] ?? routes[key];
      if (route) {
        let body = {};
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          body = raw ? JSON.parse(raw) : {};
        }
        return send(200, await route(Object.fromEntries(url.searchParams), body));
      }
      if (req.method !== 'GET') return send(404, { error: 'not found' });
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.resolve(PUBLIC, rel);
      if (!full.startsWith(PUBLIC) || !(await exists(full))) return send(404, { error: 'not found' });
      send(200, await readFile(full), TYPES[path.extname(full)] ?? 'application/octet-stream');
    } catch (err) {
      send(err.status ?? 500, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch((err) => {
    // Already running (EADDRINUSE): just open the existing UI.
    if (err.code !== 'EADDRINUSE') throw err;
    console.log(`hyperion UI already running on port ${port}`);
    if (open) openWindow(`http://127.0.0.1:${port}`);
    setTimeout(() => process.exit(0), 500);
  });
  const url = `http://127.0.0.1:${port}`;
  console.log(`hyperion UI: ${url}  (project: ${project?.root ?? 'none — open or create one in the UI'})`);
  if (open) openWindow(url);
  return server;
}
