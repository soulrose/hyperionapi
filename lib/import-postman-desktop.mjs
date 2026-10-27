// Import GraphQL requests straight from the Postman desktop app's local store (its export leaves GraphQL-type
// requests out). Read-only: the store is copied to a temp folder first and Postman is never touched.
import { readdir, mkdtemp, copyFile, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import YAML from 'yaml';
import { readLevelDb } from './leveldb.mjs';
import { exists, readYaml, loadEnv, listRequestFiles } from './project.mjs';
import { createCollection } from './scaffold.mjs';
import { slug } from './util.mjs';

/** Every Postman desktop IndexedDB store on this machine (one per signed-in partition). */
export async function findPostmanStores() {
  const base = path.join(process.env.APPDATA ?? '', 'Postman', 'Partitions');
  if (!(await exists(base))) return [];
  const out = [];
  for (const p of await readdir(base)) {
    const dir = path.join(base, p, 'IndexedDB', 'https_desktop.postman.com_0.indexeddb.leveldb');
    if (await exists(dir)) out.push(dir);
  }
  return out;
}

/** Chromium IndexedDB values: a small Blink header, then V8's serialization (starts at ff 0f). */
function decode(value) {
  for (let i = 0; i < Math.min(value?.length ?? 0, 40); i++) {
    if (value[i] !== 0xff || value[i + 1] !== 0x0f) continue;
    try {
      const o = v8.deserialize(value.subarray(i));
      return o && typeof o === 'object' && o.value && o.value.$kind ? o.value : o;
    } catch {
      // not this offset
    }
  }
  return undefined;
}

async function readStore(dir) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hyperion-postman-'));
  try {
    for (const f of await readdir(dir)) if (/\.(ldb|log|sst)$/.test(f)) await copyFile(path.join(dir, f), path.join(tmp, f));
    return (await readLevelDb(tmp)).map((e) => decode(e.value)).filter((o) => o && typeof o === 'object');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * What Postman desktop has: collections with their GraphQL requests.
 * Requests Postman has only listed (never opened in this app) have no query yet → `namesOnly`.
 */
export async function scanPostmanDesktop() {
  const stores = await findPostmanStores();
  const objs = (await Promise.all(stores.map(readStore))).flat();
  const names = new Map();
  for (const o of objs) if (o.$kind === 'collection' && o.name) names.set(o.id, o.name);
  const best = new Map(); // id → fullest, newest copy
  for (const o of objs) {
    if (o.$kind !== 'graphql-request' || !o.id) continue;
    const cur = best.get(o.id);
    const score = (x) => (x.isPartial ? 0 : 2) + (typeof x.query === 'string' ? 1 : 0);
    if (!cur || score(o) > score(cur) || (score(o) === score(cur) && String(o.updatedAt) > String(cur.updatedAt))) best.set(o.id, o);
  }
  const cols = new Map();
  for (const r of best.values()) {
    const key = r.collectionId ?? '?';
    if (!cols.has(key)) cols.set(key, { id: key, name: names.get(key) ?? 'Postman', requests: [], namesOnly: [] });
    const c = cols.get(key);
    // a parent other than the collection is a folder (Postman stores folders with their names like collections)
    r.folder = r.parentId && r.parentId !== key ? names.get(r.parentId) ?? '' : '';
    if (typeof r.query === 'string' && !r.isPartial) c.requests.push(r);
    else c.namesOnly.push(r.folder ? `${r.folder} / ${r.name}` : r.name);
  }
  return { stores: stores.length, collections: [...cols.values()].sort((a, b) => b.requests.length - a.requests.length) };
}

/**
 * A collection's variables as Postman desktop shows them: the "current value" (kept locally, not synced) when
 * there is one, else the initial value. Matched by collection name. Request logs and other records are not read.
 */
export async function postmanCollectionVariables(name) {
  const stores = await findPostmanStores();
  const objs = (await Promise.all(stores.map(readStore))).flat();
  const want = String(name ?? '').trim().toLowerCase();
  const col = objs
    .filter((o) => o.$kind === 'collection' && String(o.name ?? '').trim().toLowerCase() === want && Array.isArray(o.variables))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (!col) return { found: false, stores: stores.length, variables: [] };
  const current = new Map();
  for (const o of objs) {
    if (o.model !== 'collection' || o.modelId !== col.id || !Array.isArray(o.values)) continue;
    for (const v of o.values) if (v?.key) current.set(v.key, v.value);
  }
  const out = col.variables.filter((v) => v?.key && !v.disabled).map((v) => ({ key: v.key, value: String(current.get(v.key) ?? v.value ?? ''), description: v.description ?? '' }));
  for (const [key, value] of current) if (!out.some((v) => v.key === key)) out.push({ key, value: String(value ?? ''), description: '' });
  return { found: true, name: col.name, hasCurrent: current.size > 0, variables: out };
}

const RAW_TOKEN = /^(Bearer\s+)?[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/; // a JWT pasted as is

function mapAuth(a, notes, name) {
  if (!a || a.type === 'inherit') return undefined;
  if (a.type === 'noauth') return 'none';
  if (a.type === 'bearer') {
    const token = a.credentials?.find((c) => c.key === 'token')?.value ?? '';
    if (!token) return undefined;
    if (RAW_TOKEN.test(token)) {
      notes.add('token ที่ฝังอยู่ใน request ถูกตัดออก (หมดอายุแล้วและไม่ควรอยู่ในไฟล์) — ใช้ Keycloak login หรือวาง token ในแท็บ Authorization');
      return undefined;
    }
    return { type: 'bearer', bearer: { token } };
  }
  notes.add(`${name}: auth แบบ ${a.type} ยังไม่ได้แปลง — ใช้ auth ของ collection แทน`);
  return undefined;
}

function mapHeaders(list, notes) {
  const out = {};
  for (const h of list ?? []) {
    if (h.disabled || !h.key) continue;
    if (h.key.toLowerCase() === 'content-type') continue;
    if (h.key.toLowerCase() === 'authorization' && !/\{\{/.test(h.value)) {
      notes.add('Authorization header ที่มี token จริงถูกตัดออก — ใช้ Keycloak login หรือวาง token ในแท็บ Authorization');
      continue;
    }
    out[h.key] = h.value;
  }
  return out;
}

function parseVariables(text, notes, name) {
  if (!text || !String(text).trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(String(text).replace(/(?<!")\{\{([^}]+)\}\}(?!")/g, '"{{$1}}"'));
    } catch {
      notes.add(`${name}: variables ไม่ใช่ JSON — ปล่อยว่าง`);
      return {};
    }
  }
}

/**
 * Import the chosen Postman collections (by id) into the project. Each becomes / updates a Hyperion collection
 * of the same name; requests remember their Postman id so a second import updates instead of duplicating.
 */
export async function importPostmanDesktop(project, { ids, envName } = {}) {
  const scan = await scanPostmanDesktop();
  const chosen = scan.collections.filter((c) => !ids?.length || ids.includes(c.id));
  const report = [];
  for (const c of chosen) {
    const notes = new Set();
    // the collection: reuse one with the same name, else create it
    const colsRoot = path.join(project.root, 'collections');
    let dir = null;
    if (await exists(colsRoot)) {
      for (const d of await readdir(colsRoot)) {
        const f = path.join(colsRoot, d, '_collection.yaml');
        if ((await exists(f)) && (await readYaml(f)).metadata?.name === c.name) dir = path.join(colsRoot, d);
      }
    }
    if (!dir) dir = path.resolve(project.root, (await createCollection(project, { name: c.name, url: '{{GQL_URL}}' })).dir);

    // URLs: every request follows the selected env ({{GQL_URL}}), so nothing is wired to prod behind the env picker.
    // The Postman URL stays in metadata. Env URLs are filled only when the host name says which env it is
    // (…-dev / …-test / …training…) and that env has no URL yet — prod is never guessed.
    const hosts = new Map();
    for (const r of c.requests) if (r.url) hosts.set(r.url, (hosts.get(r.url) ?? 0) + 1);
    for (const [u, n] of hosts) notes.add(`${n} request ใน Postman ใช้ ${u}`);
    const guess = (u) => (/[-.]dev[-.]|\/\/dev[-.]/i.test(u) ? 'dev' : /[-.]test[-.]|\/\/test[-.]/i.test(u) ? 'test' : /training/i.test(u) ? 'training' : null);
    for (const u of hosts.keys()) {
      const name = guess(u);
      if (!name || !(await exists(path.join(project.root, 'envs', `${name}.env.yaml`)))) continue;
      const env = await loadEnv(project, name);
      const cur = String(env.variables.GQL_URL ?? '');
      if (cur && !/<[^>]+>/.test(cur)) continue;
      const envDoc = YAML.parseDocument(await readFile(env.file, 'utf8'));
      envDoc.setIn(['variables', 'GQL_URL'], u);
      await writeFile(env.file, envDoc.toString({ lineWidth: 0 }), 'utf8');
      notes.add(`ตั้ง GQL_URL ของ env ${name} = ${u}`);
    }
    notes.add('ทุก request ใช้ URL ของ env ที่เลือก ({{GQL_URL}}) — ตั้ง URL ของ prod / env อื่นได้ที่ช่อง URL ในแถบแดง');
    // values written straight into a query (tokens, 13-digit IDs) are kept as they are, but named
    const inline = c.requests.filter((r) => /"eyJ[A-Za-z0-9_-]{10,}\./.test(r.query) || /"\d{13}"/.test(r.query)).map((r) => r.name);
    if (inline.length) notes.add(`query ที่มี token หรือเลขบัตร 13 หลักเขียนตรงในข้อความ (ควรเปลี่ยนเป็นตัวแปรก่อน commit): ${inline.join(', ')}`);

    // existing files by Postman id, so re-imports update in place
    const byPostmanId = new Map();
    for (const f of await listRequestFiles([dir])) {
      const d = await readYaml(f).catch(() => ({}));
      if (d.metadata?.postmanId) byPostmanId.set(d.metadata.postmanId, f);
    }
    const used = new Set();
    let created = 0;
    let updated = 0;
    for (const r of c.requests) {
      const execution = {};
      const headers = mapHeaders(r.headers, notes);
      if (Object.keys(headers).length) execution.headers = headers;
      const auth = mapAuth(r.auth, notes, r.name);
      if (auth) execution.auth = auth;
      const opName = String(r.query).match(/\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/)?.[1];
      const doc = {
        apiVersion: 'hyperion/v3',
        kind: 'GraphQLRequest',
        metadata: { name: r.name, postmanId: r.id, ...(r.url ? { postmanUrl: r.url } : {}), ...(r.description ? { description: r.description } : {}) },
        ...(Object.keys(execution).length ? { execution } : {}),
        payload: {
          ...(opName ? { operationName: opName } : {}),
          query: String(r.query).endsWith('\n') ? String(r.query) : `${r.query}\n`,
          variables: parseVariables(r.variables, notes, r.name),
        },
      };
      let file = byPostmanId.get(r.id);
      if (file) updated++;
      else {
        const folderDir = r.folder ? path.join(dir, slug(r.folder)) : dir;
        let base = slug(r.name);
        for (let i = 2; used.has(path.join(folderDir, base)) || (await exists(path.join(folderDir, `${base}.req.yaml`))); i++) base = `${slug(r.name)}-${i}`;
        file = path.join(folderDir, `${base}.req.yaml`);
        created++;
      }
      used.add(file.replace(/\.req\.yaml$/, ''));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, YAML.stringify(doc, { blockQuote: 'literal', lineWidth: 0 }), 'utf8');
    }
    report.push({
      collection: c.name,
      dir: path.relative(project.root, dir).replaceAll(path.sep, '/'),
      created,
      updated,
      namesOnly: c.namesOnly,
      notes: [...notes],
    });
  }
  return report;
}
