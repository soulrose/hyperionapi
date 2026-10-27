// Export / import as one file (*.hyperion.json): a collection, or a flow with every request it runs. The collection and
// folder settings (_collection.yaml, _folder.yaml) go along so the requests work in another project; secrets never do
// ({{secret:…}} references stay, secrets.local.yaml is not read).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists } from './project.mjs';

const KIND = 'HyperionExport';
const rel = (project, p) => path.relative(project.root, p).replaceAll(path.sep, '/');
const ALLOWED = /^(collections\/.+\/(_collection|_folder)\.yaml|collections\/.+\.req\.yaml|flows\/[^/]+\.flow\.yaml|hyperion\.yaml|\.gitignore|secrets\.local\.yaml\.example|envs\/[^/.]+\.env\.yaml)$/;
// never exported: secrets.local.yaml, envs/*.local.env.yaml (tokens), .hyperion/ (cache, trash)

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

/** files: collection folders, requests (*.req.yaml) and / or flows (*.flow.yaml), relative to the project. */
export async function exportBundle(project, files = []) {
  const wanted = new Set();
  const add = async (full) => {
    wanted.add(full);
    if (full.endsWith('.req.yaml')) for (const s of await settingsFor(project, full)) wanted.add(s);
  };
  for (const f of files) {
    // a collection folder: everything in it (requests, folder settings, its _collection.yaml)
    const dir = path.resolve(project.root, f);
    if (dir.startsWith(path.join(project.root, 'collections') + path.sep) && (await exists(path.join(dir, '_collection.yaml')))) {
      for (const x of await readdir(dir, { recursive: true })) {
        const full = path.join(dir, String(x));
        if (/(\.req\.yaml|_folder\.yaml|_collection\.yaml)$/.test(full)) wanted.add(full);
      }
      continue;
    }
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
  // settings (collection / folder / env / project files): only where there are none yet
  for (const it of items.filter((x) => !/\.(req|flow)\.yaml$/.test(x.path))) {
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

/** The whole project: hyperion.yaml, envs (not the .local token files), every collection and flow — never secrets. */
export async function exportProject(project) {
  const files = [];
  const add = async (rel) => (await exists(path.join(project.root, rel))) && files.push(rel);
  await add('hyperion.yaml');
  await add('.gitignore');
  await add('secrets.local.yaml.example');
  for (const sub of ['envs', 'collections', 'flows']) {
    const dir = path.join(project.root, sub);
    if (!(await exists(dir))) continue;
    for (const x of await readdir(dir, { recursive: true })) {
      const r = `${sub}/${String(x).replaceAll(path.sep, '/')}`;
      if (ALLOWED.test(r)) files.push(r);
    }
  }
  const items = [];
  for (const r of files.sort()) items.push({ path: r, content: await readFile(path.join(project.root, r), 'utf8') });
  const name = (YAML.parse(await readFile(path.join(project.root, 'hyperion.yaml'), 'utf8')) ?? {}).name;
  return { apiVersion: 'hyperion/v3', kind: KIND, project: name ?? path.basename(project.root), exportedAt: new Date().toISOString(), items };
}

/** A new project folder from a project export (the folder must be new or empty). */
export async function importProject(root, bundle) {
  if (bundle?.kind !== KIND || !bundle.items?.some((i) => i.path === 'hyperion.yaml')) throw new Error('Not a project export — it has no hyperion.yaml');
  if ((await exists(root)) && (await readdir(root)).length) throw new Error(`The folder is not empty: ${root}`);
  const result = await importBundle({ root }, bundle);
  return { ...result, files: bundle.items.length };
}
