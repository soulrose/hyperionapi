// Export / import as one file (*.hyperion.json): a request, or a flow with every request it runs. The collection and
// folder settings (_collection.yaml, _folder.yaml) go along so the requests work in another project; secrets never do
// ({{secret:…}} references stay, secrets.local.yaml is not read).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists } from './project.mjs';

const KIND = 'HyperionExport';
const rel = (project, p) => path.relative(project.root, p).replaceAll(path.sep, '/');
const ALLOWED = /^(collections\/.+\/(_collection|_folder)\.yaml|collections\/.+\.req\.yaml|flows\/[^/]+\.flow\.yaml)$/;

function inside(project, p) {
  const full = path.resolve(project.root, p);
  if (!full.startsWith(project.root + path.sep) || !ALLOWED.test(rel(project, full))) throw new Error(`Not a request or flow file: ${p}`);
  return full;
}

// the collection's _collection.yaml and every _folder.yaml between it and the request
async function settingsFor(project, requestFile) {
  const out = [];
  for (let d = path.dirname(requestFile); d.startsWith(path.join(project.root, 'collections')); d = path.dirname(d)) {
    if (await exists(path.join(d, '_folder.yaml'))) out.push(path.join(d, '_folder.yaml'));
    if (await exists(path.join(d, '_collection.yaml'))) {
      out.push(path.join(d, '_collection.yaml'));
      break;
    }
  }
  return out;
}

/** files: request (*.req.yaml) and / or flow (*.flow.yaml) paths, relative to the project. */
export async function exportBundle(project, files = []) {
  const wanted = new Set();
  const add = async (full) => {
    wanted.add(full);
    if (full.endsWith('.req.yaml')) for (const s of await settingsFor(project, full)) wanted.add(s);
  };
  for (const f of files) {
    const full = inside(project, f);
    await add(full);
    if (full.endsWith('.flow.yaml')) {
      const flow = YAML.parse(await readFile(full, 'utf8')) ?? {};
      for (const s of flow.steps ?? []) if (s.request && (await exists(path.resolve(project.root, s.request)))) await add(inside(project, s.request));
    }
  }
  const items = [];
  for (const full of [...wanted].sort()) items.push({ path: rel(project, full), content: await readFile(full, 'utf8') });
  return { apiVersion: 'hyperion/v3', kind: KIND, exportedAt: new Date().toISOString(), items };
}

/**
 * Settings files are written only where there are none (yours are never overwritten). A request that is already there
 * with the same content is skipped; a different one is saved next to it under a new name and flows are pointed at it.
 */
export async function importBundle(project, bundle) {
  if (bundle?.kind !== KIND || !Array.isArray(bundle.items)) throw new Error('Not a Hyperion export file (*.hyperion.json)');
  const result = { collections: [], requests: { created: [], same: [], renamed: [] }, flows: [] };
  const moved = new Map(); // request path in the file → where it was saved here
  const items = bundle.items.map((it) => ({ ...it, full: inside(project, it.path) }));
  const write = async (full, content) => {
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  };
  for (const it of items.filter((x) => /(_collection|_folder)\.yaml$/.test(x.path))) {
    if (await exists(it.full)) continue;
    await write(it.full, it.content);
    if (it.path.endsWith('_collection.yaml')) result.collections.push(path.dirname(it.path));
  }
  for (const it of items.filter((x) => x.path.endsWith('.req.yaml'))) {
    if (!(await exists(it.full))) {
      await write(it.full, it.content);
      result.requests.created.push(it.path);
      continue;
    }
    if ((await readFile(it.full, 'utf8')) === it.content) {
      result.requests.same.push(it.path);
      continue;
    }
    let full = it.full.replace(/\.req\.yaml$/, '-imported.req.yaml');
    for (let i = 2; await exists(full); i++) full = it.full.replace(/\.req\.yaml$/, `-imported-${i}.req.yaml`);
    await write(full, it.content);
    moved.set(it.path, rel(project, full));
    result.requests.renamed.push({ from: it.path, to: rel(project, full) });
  }
  for (const it of items.filter((x) => x.path.endsWith('.flow.yaml'))) {
    const flow = YAML.parse(it.content) ?? {};
    for (const s of flow.steps ?? []) if (moved.has(s.request)) s.request = moved.get(s.request);
    let full = it.full;
    for (let i = 2; await exists(full); i++) full = it.full.replace(/\.flow\.yaml$/, `-${i}.flow.yaml`);
    await write(full, YAML.stringify(flow, { blockQuote: 'literal', lineWidth: 0 }));
    result.flows.push(rel(project, full));
  }
  return result;
}
