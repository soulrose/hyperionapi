// Paste import: a cURL command (Postman "Code" → cURL, browser "Copy as cURL") or a bare GraphQL query.
// Postman's GraphQL-type requests cannot be exported, so this is how they come over.
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import YAML from 'yaml';
import { parse } from 'graphql';
import { exists, readYaml, loadEnv, saveLocalEnvVars } from './project.mjs';
import { slug } from './util.mjs';

/** Split a shell command line into words: handles '…', "…", \ and ^ line continuations (bash and cmd). */
function words(cmd) {
  const s = cmd.replace(/\\\r?\n|\^\r?\n|`\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '^' && quote === '"' && s[i + 1] === '"') cur += s[++i]; // cmd.exe: ^" inside quotes is a quote
      else if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur), (cur = ''), (started = false);
    } else if (ch === '^' && s[i + 1]) {
      cur += s[++i]; // cmd.exe escape: ^" → "
      started = true;
    } else if (ch === '\\' && s[i + 1]) {
      cur += s[++i];
      started = true;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export function parseCurl(text) {
  const w = words(text.trim());
  if (!/^curl(\.exe)?$/i.test(w[0] ?? '')) throw new Error('Not a curl command');
  const req = { method: null, url: null, headers: {}, body: null };
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i];
    if (a === '-X' || a === '--request') req.method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const c = h.indexOf(':');
      if (c > 0) req.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
    } else if (/^(-d|--data|--data-raw|--data-binary|--data-ascii|--json)$/.test(a)) req.body = (req.body ?? '') + next();
    else if (a === '--url') req.url = next();
    else if (/^(-u|--user)$/.test(a)) {
      const [u, p = ''] = next().split(':');
      req.basic = { username: u, password: p };
    } else if (/^(-o|--output|-A|--user-agent|-e|--referer|-b|--cookie|--connect-timeout|-m|--max-time)$/.test(a)) next();
    else if (!a.startsWith('-') && !req.url) req.url = a;
  }
  if (!req.url) throw new Error('No URL found in the curl command');
  req.method ??= req.body != null ? 'POST' : 'GET';
  return req;
}

// headers a browser / Postman adds that mean nothing in a saved request
const NOISE = /^(content-type|content-length|host|accept-encoding|accept-language|connection|user-agent|postman-token|cache-control|origin|referer|sec-.*|cookie|priority|pragma|dnt)$/i;

function opName(query) {
  try {
    const op = parse(query).definitions.find((d) => d.kind === 'OperationDefinition');
    return { name: op?.name?.value, type: op?.operation ?? 'query' };
  } catch (err) {
    throw new Error(`Invalid GraphQL: ${err.message}`);
  }
}

/**
 * Create a request in `collection` (project-relative dir) from pasted text.
 * envName: the env whose URL variable is filled when the collection URL is {{VAR}} and still unset,
 * and whose gitignored local overlay keeps a pasted Bearer token.
 */
export async function importPaste(project, { text, collection, name, envName }) {
  const colDir = path.resolve(project.root, collection ?? '');
  if (!(await exists(path.join(colDir, '_collection.yaml')))) throw new Error('Choose a collection to import into');
  const col = await readYaml(path.join(colDir, '_collection.yaml'));
  const notes = [];
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Paste a cURL command or GraphQL query first');

  let curl = null;
  let gql = null;
  if (/^curl(\.exe)?\s/i.test(trimmed)) {
    curl = parseCurl(trimmed);
    let body = null;
    try {
      body = curl.body ? JSON.parse(curl.body) : null;
    } catch {
      body = null;
    }
    if (body && typeof body.query === 'string') gql = { query: body.query, variables: body.variables ?? {}, operationName: body.operationName };
  } else {
    gql = { query: trimmed, variables: {} };
  }

  const doc = { apiVersion: 'hyperion/v3' };
  const headers = {};
  let auth;
  if (curl) {
    for (const [k, v] of Object.entries(curl.headers)) {
      if (NOISE.test(k)) continue;
      const bearer = k.toLowerCase() === 'authorization' && v.match(/^Bearer\s+(.+)$/i);
      if (bearer) {
        // never write the token into the request file: it goes to the env's gitignored local overlay
        if (envName && !bearer[1].includes('{{')) {
          const env = await loadEnv(project, envName);
          await saveLocalEnvVars(env, { BEARER_TOKEN: bearer[1] });
          auth = { type: 'bearer', bearer: { token: '{{BEARER_TOKEN}}' } };
          notes.push(`Bearer token saved in envs/${envName}.local.env.yaml as BEARER_TOKEN (not in the request file)`);
        } else auth = { type: 'bearer', bearer: { token: bearer[1] } };
        continue;
      }
      headers[k] = v;
    }
    if (curl.basic) auth = { type: 'basic', basic: curl.basic };
  }

  if (gql) {
    const op = opName(gql.query);
    doc.kind = 'GraphQLRequest';
    doc.metadata = { name: name?.trim() || op.name || 'Pasted query' };
    // URL: the collection's {{VAR}} wins; fill that variable for this env if it is still unset
    const colUrl = String(col.execution?.url ?? '');
    const m = colUrl.trim().match(/^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/);
    const execution = {};
    if (curl) {
      if (m && envName) {
        const env = await loadEnv(project, envName);
        const cur = String(env.variables[m[1]] ?? '');
        if (!cur || /<[^>]+>/.test(cur)) {
          const envDoc = YAML.parseDocument(await readFile(env.file, 'utf8'));
          envDoc.setIn(['variables', m[1]], curl.url);
          await writeFile(env.file, envDoc.toString({ lineWidth: 0 }), 'utf8');
          notes.push(`Set ${m[1]} for env ${envName} = ${curl.url}`);
        } else if (cur !== curl.url) notes.push(`Pasted URL (${curl.url}) differs from ${m[1]} of ${envName} (${cur}) — using the env value`);
      } else if (!colUrl) execution.url = curl.url;
      else if (colUrl !== curl.url) execution.url = curl.url;
    }
    if (Object.keys(headers).length) execution.headers = headers;
    if (auth) execution.auth = auth;
    if (Object.keys(execution).length) doc.execution = execution;
    doc.payload = {
      ...(op.name || gql.operationName ? { operationName: gql.operationName ?? op.name } : {}),
      query: gql.query.endsWith('\n') ? gql.query : `${gql.query}\n`,
      variables: gql.variables ?? {},
    };
  } else {
    doc.kind = 'HttpRequest';
    doc.metadata = { name: name?.trim() || `${curl.method} ${new URL(curl.url).pathname}` };
    doc.method = curl.method;
    doc.url = curl.url;
    if (Object.keys(headers).length) doc.headers = headers;
    if (auth) doc.auth = auth;
    if (curl.body != null) {
      try {
        doc.body = JSON.parse(curl.body);
      } catch {
        doc.body = curl.body;
      }
    }
  }

  await mkdir(colDir, { recursive: true });
  let file = path.join(colDir, `${slug(doc.metadata.name)}.req.yaml`);
  for (let i = 2; await exists(file); i++) file = path.join(colDir, `${slug(doc.metadata.name)}-${i}.req.yaml`);
  await writeFile(file, YAML.stringify(doc, { blockQuote: 'literal', lineWidth: 0 }), 'utf8');
  return { file: path.relative(project.root, file).replaceAll(path.sep, '/'), kind: doc.kind, name: doc.metadata.name, notes };
}
