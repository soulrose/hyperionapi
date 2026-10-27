// Create collections and requests (UI "New collection" / "New request", CLI `hyperion new`).
import { readdir, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists, readYaml } from './project.mjs';
import { slug } from './util.mjs';

const MASKING = ['fullName', 'firstName', 'lastName', 'name', 'idCard', 'citizenId', 'phone', 'address'];

/** Every directory under collections/ that has a _collection.yaml. */
export async function listCollections(project) {
  const root = path.join(project.root, 'collections');
  const out = [];
  const walk = async (dir) => {
    if (await exists(path.join(dir, '_collection.yaml'))) {
      const c = await readYaml(path.join(dir, '_collection.yaml'));
      // type: graphql | rest (when not set, the UI decides from the requests inside)
      out.push({ dir: path.relative(project.root, dir).replaceAll('\\', '/'), name: c.metadata?.name ?? path.basename(dir), type: c.type ?? null });
      return; // a collection does not nest another one
    }
    for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await walk(path.join(dir, e.name));
  };
  if (await exists(root)) await walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function freeDir(base) {
  let p = base;
  for (let i = 2; await exists(p); i++) p = `${base}-${i}`;
  return p;
}

/**
 * New collection. `from` (a collection dir) copies its auth, headers, schemaDiscovery and masking,
 * so a second collection for the same API reuses the login without retyping it.
 */
export async function createCollection(project, { name, url, from, type } = {}) {
  if (!name?.trim()) throw new Error('collection name is required');
  const dir = await freeDir(path.join(project.root, 'collections', slug(name)));
  let base = {};
  if (from) {
    const src = path.resolve(project.root, from, '_collection.yaml');
    if (!src.startsWith(path.join(project.root, 'collections'))) throw new Error('source collection must be under collections/');
    base = await readYaml(src);
  }
  const OTHER = ['rest', 'grpc', 'websocket', 'soap'];
  const kind = OTHER.includes(type) ? type : !type && OTHER.includes(base.type) ? base.type : 'graphql';
  const defaultUrl = { rest: '{{BASE_URL}}', grpc: '{{GRPC_ADDRESS}}', websocket: '{{WS_URL}}', soap: '{{SOAP_URL}}', graphql: '{{GQL_URL}}' }[kind];
  const execution = { ...(base.execution ?? {}), url: url?.trim() || base.execution?.url || defaultUrl };
  execution.timeoutMs ??= 15000;
  const doc = {
    apiVersion: 'hyperion/v3',
    kind: 'Collection',
    type: kind,
    metadata: { name: name.trim() },
    ...(base.variables ? { variables: base.variables } : {}),
    masking: base.masking ?? { fields: MASKING },
    execution,
    // only GraphQL has a schema to discover
    ...(kind !== 'graphql' ? {} : { schemaDiscovery: base.schemaDiscovery ? { ...base.schemaDiscovery } : { mode: 'AUTO_FALLBACK', probeTarget: true, fallbackUrl: '{{SCHEMA_URL}}', cacheTtlMinutes: 1440 } }),
  };
  // the offline snapshot path is relative to the collection file — keep it pointing at the same file
  if (doc.schemaDiscovery?.offlineSnapshot && from) {
    const abs = path.resolve(project.root, from, doc.schemaDiscovery.offlineSnapshot);
    doc.schemaDiscovery.offlineSnapshot = path.relative(dir, abs).replaceAll('\\', '/');
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '_collection.yaml'), YAML.stringify(doc, { lineWidth: 0 }));
  return { dir: path.relative(project.root, dir).replaceAll('\\', '/'), name: doc.metadata.name, type: kind };
}

const opName = (name) => name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[^A-Za-z_]+/, '').replace(/^./, (c) => c.toUpperCase()) || 'MyQuery';

/** New request file inside a collection (optionally in a sub-folder). Returns its project-relative path. */
export async function createRequest(project, { collection, name, folder = '', kind = 'GraphQLRequest', method = 'GET', url = '', soap } = {}) {
  if (!name?.trim()) throw new Error('request name is required');
  const colDir = path.resolve(project.root, collection);
  if (!(await exists(path.join(colDir, '_collection.yaml')))) throw new Error(`not a collection: ${collection}`);
  const dir = path.resolve(colDir, ...folder.split(/[\\/]/).filter(Boolean).map(slug));
  if (!dir.startsWith(colDir)) throw new Error('folder must stay inside the collection');
  await mkdir(dir, { recursive: true });
  let file = path.join(dir, `${slug(name)}.req.yaml`);
  for (let i = 2; await exists(file); i++) file = path.join(dir, `${slug(name)}-${i}.req.yaml`);

  const op = opName(name);
  const head = { apiVersion: 'hyperion/v3', kind, metadata: { name: name.trim() } };
  // realtime kinds start from the collection URL (e.g. {{WS_URL}}) and a message to send
  const realtime = {
    WebSocketRequest: { ...head, message: '{\n  "type": "ping"\n}\n' },
    SocketIORequest: { ...head, event: 'message', message: '{\n  "text": "hello"\n}\n' },
    GrpcRequest: { ...head, url: url || '{{GRPC_ADDRESS}}', proto: '', message: '{}\n' },
    // SOAP inherits the collection URL ({{SOAP_URL}}); `soap` fills it from a WSDL operation (import)
    SoapRequest: {
      ...head,
      ...(url ? { url } : {}),
      soapVersion: soap?.soapVersion ?? '1.1',
      action: soap?.action ?? '',
      ...(soap?.operation ? { operation: soap.operation } : {}),
      ...(soap?.wsdl ? { wsdl: soap.wsdl } : {}),
      envelope: soap?.envelope ?? SOAP_STARTER,
    },
  };
  const doc =
    realtime[kind] ??
    (kind === 'HttpRequest'
      ? { ...head, method: method.toUpperCase(), url: url || '{{BASE_URL}}/' }
      : {
          apiVersion: 'hyperion/v3',
          kind: 'GraphQLRequest',
          metadata: { name: name.trim() },
          payload: { operationName: op, query: `query ${op} {\n  \n}\n`, variables: {} },
        });
  await writeFile(file, YAML.stringify(doc, { blockQuote: 'literal', lineWidth: 0 }));
  return path.relative(project.root, file).replaceAll('\\', '/');
}

const SOAP_STARTER = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Header/>\n  <soap:Body>\n  </soap:Body>\n</soap:Envelope>\n';

const rel = (project, p) => path.relative(project.root, p).replaceAll(path.sep, '/');

/** Move one request file into another collection (and optional sub-folder). */
export async function moveRequest(project, { file, collection, folder = '' } = {}) {
  const src = path.resolve(project.root, file);
  const colDir = path.resolve(project.root, collection);
  if (!src.startsWith(path.join(project.root, 'collections')) || !src.endsWith('.req.yaml')) throw new Error('not a request file');
  if (!(await exists(path.join(colDir, '_collection.yaml')))) throw new Error(`not a collection: ${collection}`);
  const dir = path.resolve(colDir, ...folder.split(/[\/]/).filter(Boolean).map(slug));
  if (!dir.startsWith(colDir)) throw new Error('folder must stay inside the collection');
  await mkdir(dir, { recursive: true });
  const base = path.basename(src, '.req.yaml');
  let dest = path.join(dir, `${base}.req.yaml`);
  if (dest === src) return rel(project, dest);
  for (let i = 2; await exists(dest); i++) dest = path.join(dir, `${base}-${i}.req.yaml`);
  await rename(src, dest);
  return rel(project, dest);
}

/**
 * Split a folder out into its own collection: the new collection starts as a copy of the parent's
 * settings (auth, headers, schema), the folder's own _folder.yaml is merged into it, and every file moves over.
 */
export async function splitFolder(project, { folder, name } = {}) {
  const src = path.resolve(project.root, folder);
  const parent = path.dirname(src);
  let colDir = parent;
  while (!(await exists(path.join(colDir, '_collection.yaml')))) {
    if (colDir === path.dirname(colDir) || !colDir.startsWith(path.join(project.root, 'collections'))) throw new Error('folder is not inside a collection');
    colDir = path.dirname(colDir);
  }
  if (await exists(path.join(src, '_collection.yaml'))) throw new Error('this folder is already a collection');
  const created = await createCollection(project, { name: name?.trim() || path.basename(src), from: rel(project, colDir) });
  const destDir = path.resolve(project.root, created.dir);

  const folderCfgFile = path.join(src, '_folder.yaml');
  if (await exists(folderCfgFile)) {
    const f = await readYaml(folderCfgFile);
    const colFile = path.join(destDir, '_collection.yaml');
    const c = await readYaml(colFile);
    const fe = f.execution ?? {};
    c.execution = { ...c.execution, ...fe, headers: { ...(c.execution?.headers ?? {}), ...(fe.headers ?? f.headers ?? {}) } };
    if (fe.auth ?? f.auth) c.execution.auth = fe.auth ?? f.auth;
    if (!Object.keys(c.execution.headers).length) delete c.execution.headers;
    if (f.variables) c.variables = { ...(c.variables ?? {}), ...f.variables };
    await writeFile(colFile, YAML.stringify(c, { lineWidth: 0 }));
    await rm(folderCfgFile);
  }
  let moved = 0;
  for (const e of await readdir(src, { withFileTypes: true })) {
    await rename(path.join(src, e.name), path.join(destDir, e.name));
    if (e.name.endsWith('.req.yaml')) moved++;
    else if (e.isDirectory()) moved += (await readdir(path.join(destDir, e.name), { recursive: true })).filter((n) => String(n).endsWith('.req.yaml')).length;
  }
  await rm(src, { recursive: true, force: true });
  return { ...created, moved };
}
