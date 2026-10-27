// Import Postman v2.x collections and environments into the project's YAML layout.
// Never overwrites: a name that already exists gets a -2, -3, ... suffix.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists, readYaml } from './project.mjs';
import { slug } from './util.mjs';

const SECRETISH = /pass(word)?|secret|token|api[_-]?key|client[_-]?secret|private/i;

export async function importPostman(project, json, { fileName = 'import.json' } = {}) {
  if (json?.item && json?.info) return importCollection(project, json);
  if (Array.isArray(json?.values)) return importEnvironment(project, json, fileName);
  throw new Error('not a Postman collection (v2.x) or environment export');
}

async function freePath(base, ext = '') {
  let p = `${base}${ext}`;
  for (let i = 2; await exists(p); i++) p = `${base}-${i}${ext}`;
  return p;
}

const yaml = (obj) => YAML.stringify(obj, { blockQuote: 'literal', lineWidth: 0 });

function kv(list) {
  return Object.fromEntries((list ?? []).filter((x) => !x.disabled).map((x) => [x.key, x.value ?? '']));
}

function mapAuth(a, notes, where) {
  if (!a) return undefined;
  const p = kv(a[a.type]);
  switch (a.type) {
    case 'noauth':
      return 'none';
    case 'bearer':
      return { type: 'bearer', bearer: { token: p.token ?? '' } };
    case 'basic':
      return { type: 'basic', basic: { username: p.username ?? '', password: p.password ?? '' } };
    case 'apikey':
      return { type: 'apiKey', apiKey: { in: p.in === 'query' ? 'query' : 'header', name: p.key ?? 'X-API-Key', value: p.value ?? '' } };
    case 'oauth2':
      notes.push(`${where}: OAuth2 imported as bearer {{ACCESS_TOKEN}} — switch to type tokenEndpoint for auto refresh`);
      return { type: 'bearer', bearer: { token: p.accessToken ? '{{ACCESS_TOKEN}}' : '{{ACCESS_TOKEN}}' } };
    default:
      notes.push(`${where}: auth type "${a.type}" not supported — left out`);
      return undefined;
  }
}

/** Postman GraphQL variables are a string that may contain bare {{var}} (invalid JSON). */
function parseLooseJson(text) {
  if (!text?.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/(?<!")\{\{([^}]+)\}\}(?!")/g, '"{{$1}}"'));
    } catch {
      return null;
    }
  }
}

function scriptsOf(events) {
  const get = (listen) => {
    const exec = events?.find((e) => e.listen === listen)?.script?.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : exec;
    return code?.trim() ? `${code.trim()}\n` : undefined;
  };
  const s = { beforeRequest: get('prerequest'), afterResponse: get('test') };
  return s.beforeRequest || s.afterResponse ? Object.fromEntries(Object.entries(s).filter(([, v]) => v)) : undefined;
}

const rawUrl = (u) => (typeof u === 'string' ? u : u?.raw ?? '');

function convertRequest(item, notes, where) {
  const r = item.request ?? {};
  const method = (r.method ?? 'GET').toUpperCase();
  const url = rawUrl(r.url);
  const headers = kv(r.header);
  const auth = mapAuth(r.auth, notes, where);
  const scripts = scriptsOf(item.event);
  const body = r.body ?? {};

  let gql = null;
  if (body.mode === 'graphql') gql = { query: body.graphql?.query ?? '', variables: parseLooseJson(body.graphql?.variables) };
  else if (body.mode === 'raw' && method === 'POST') {
    const parsed = parseLooseJson(body.raw);
    if (parsed && typeof parsed.query === 'string') gql = { query: parsed.query, variables: parsed.variables ?? {}, operationName: parsed.operationName };
  }

  if (gql) {
    if (gql.variables === null) {
      notes.push(`${where}: GraphQL variables were not valid JSON — left empty`);
      gql.variables = {};
    }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
    const opName = gql.operationName ?? gql.query.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/)?.[1];
    return {
      url,
      doc: {
        apiVersion: 'hyperion/v3',
        kind: 'GraphQLRequest',
        metadata: { name: item.name },
        execution: { url, ...(Object.keys(headers).length ? { headers } : {}), ...(auth ? { auth } : {}) },
        payload: { ...(opName ? { operationName: opName } : {}), query: gql.query.endsWith('\n') ? gql.query : `${gql.query}\n`, variables: gql.variables },
        ...(scripts ? { scripts } : {}),
      },
    };
  }

  const doc = { apiVersion: 'hyperion/v3', kind: 'HttpRequest', metadata: { name: item.name }, method, url };
  if (Object.keys(headers).length) doc.headers = headers;
  if (auth) doc.auth = auth;
  if (body.mode === 'raw' && body.raw) {
    const lang = body.options?.raw?.language;
    const parsed = lang === 'json' || /^\s*[[{]/.test(body.raw) ? parseLooseJson(body.raw) : null;
    doc.body = parsed ?? body.raw;
  } else if (body.mode === 'urlencoded') {
    doc.body = new URLSearchParams((body.urlencoded ?? []).filter((p) => !p.disabled).map((p) => [p.key, p.value ?? ''])).toString();
    doc.headers = { ...(doc.headers ?? {}), 'Content-Type': 'application/x-www-form-urlencoded' };
  } else if (body.mode && body.mode !== 'none' && body.mode !== 'raw') {
    notes.push(`${where}: body mode "${body.mode}" not supported — left out`);
  }
  if (scripts) doc.scripts = scripts;
  return { url, doc };
}

async function importCollection(project, json) {
  const notes = [];
  const name = json.info.name ?? 'Imported';
  const dir = await freePath(path.join(project.root, 'collections', slug(name)));
  const written = [];
  const gqlUrls = new Set();
  const requests = [];

  const walk = async (items, folderDir, trail) => {
    const used = new Set();
    for (const it of items ?? []) {
      const where = [...trail, it.name].join(' / ');
      if (Array.isArray(it.item)) {
        const sub = path.join(folderDir, slug(it.name));
        await mkdir(sub, { recursive: true });
        const fauth = mapAuth(it.auth, notes, where);
        if (fauth || it.variable?.length) {
          await writeFile(path.join(sub, '_folder.yaml'), yaml({ apiVersion: 'hyperion/v3', kind: 'Folder', ...(fauth ? { auth: fauth } : {}), ...(it.variable?.length ? { variables: kv(it.variable) } : {}) }));
        }
        if (scriptsOf(it.event)) notes.push(`${where}: folder-level scripts are not run — copy them into the requests that need them`);
        await walk(it.item, sub, [...trail, it.name]);
        continue;
      }
      const { url, doc } = convertRequest(it, notes, where);
      let base = slug(it.name);
      for (let i = 2; used.has(base); i++) base = `${slug(it.name)}-${i}`;
      used.add(base);
      const file = path.join(folderDir, `${base}.req.yaml`);
      if (doc.kind === 'GraphQLRequest') gqlUrls.add(url);
      requests.push({ file, doc });
    }
  };
  await mkdir(dir, { recursive: true });
  await walk(json.item, dir, []);

  // If every GraphQL request hits the same URL, lift it (and nothing else) to the collection.
  const sharedUrl = gqlUrls.size === 1 ? [...gqlUrls][0] : null;
  for (const { file, doc } of requests) {
    if (sharedUrl && doc.kind === 'GraphQLRequest') {
      delete doc.execution.url;
      if (!Object.keys(doc.execution).length) delete doc.execution;
    }
    await writeFile(file, yaml(doc));
    written.push(file);
  }

  const collection = {
    apiVersion: 'hyperion/v3',
    kind: 'Collection',
    metadata: { name, ...(json.info.description ? { description: typeof json.info.description === 'string' ? json.info.description : json.info.description.content } : {}) },
    ...(json.variable?.length ? { variables: kv(json.variable) } : {}),
    execution: {
      ...(sharedUrl ? { url: sharedUrl } : {}),
      timeoutMs: 15000,
      ...(mapAuth(json.auth, notes, 'collection') ? { auth: mapAuth(json.auth, [], 'collection') } : {}),
    },
    masking: { fields: ['fullName', 'firstName', 'lastName', 'name', 'idCard', 'citizenId', 'phone', 'address'] },
    ...(gqlUrls.size ? { schemaDiscovery: { mode: 'AUTO_FALLBACK', probeTarget: true, fallbackUrl: '{{SCHEMA_URL}}', cacheTtlMinutes: 1440 } } : {}),
  };
  await writeFile(path.join(dir, '_collection.yaml'), yaml(collection));
  if (scriptsOf(json.event)) notes.push('collection-level scripts are not run — copy them into the requests that need them');
  if (gqlUrls.size) notes.push('schemaDiscovery uses {{SCHEMA_URL}} — set it in each env (Dev GraphQL URL)');

  const rel = path.relative(project.root, dir).replaceAll('\\', '/');
  return { kind: 'collection', dir: rel, count: written.length, notes, summary: `${written.length} requests → ${rel}/` };
}

async function importEnvironment(project, json, fileName) {
  const notes = [];
  const name = slug(json.name ?? path.basename(fileName, '.json').replace(/\.postman_environment$/, ''));
  const envFile = await freePath(path.join(project.root, 'envs', name), '.env.yaml');
  const envName = path.basename(envFile, '.env.yaml');
  const secretsFile = path.join(project.root, 'secrets.local.yaml');
  const secrets = (await exists(secretsFile)) ? await readYaml(secretsFile) : {};

  const variables = {};
  const moved = [];
  for (const v of json.values.filter((x) => x.enabled !== false)) {
    const value = v.value ?? '';
    if ((v.type === 'secret' || SECRETISH.test(v.key)) && value !== '' && !/^\{\{.*\}\}$/.test(value)) {
      let key = v.key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (Object.hasOwn(secrets, key) && secrets[key] !== value) key = `${envName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${key}`;
      secrets[key] = value;
      variables[v.key] = `{{secret:${key}}}`;
      moved.push(v.key);
    } else variables[v.key] = value;
  }
  const isProd = /prod/i.test(json.name ?? '');
  await mkdir(path.dirname(envFile), { recursive: true });
  await writeFile(envFile, yaml({ apiVersion: 'hyperion/v3', kind: 'Environment', metadata: { name: json.name ?? envName }, protected: isProd, variables }));
  if (moved.length) {
    await writeFile(secretsFile, `# gitignored — secrets moved out of imported environments\n${yaml(secrets)}`);
    notes.push(`moved to secrets.local.yaml: ${moved.join(', ')}`);
  }
  if (isProd) notes.push('name contains "prod" → marked protected (mutations need confirmation)');
  return { kind: 'environment', env: envName, notes, summary: `env "${envName}" (${Object.keys(variables).length} variables)` };
}
