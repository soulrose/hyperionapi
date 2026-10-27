// Project layout: hyperion.yaml, envs/*.env.yaml (+ *.local.env.yaml overlay), collections/**/_collection.yaml,
// _folder.yaml, *.req.yaml, secrets.local.yaml.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readYaml(file) {
  return YAML.parse(await readFile(file, 'utf8')) ?? {};
}

async function findUp(startDir, fileName) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (await exists(path.join(dir, fileName))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadProject(start = process.cwd()) {
  const s = await stat(start).catch(() => null);
  const root = await findUp(s?.isFile() ? path.dirname(start) : start, 'hyperion.yaml');
  if (!root) throw new Error(`hyperion.yaml not found above ${start} — run "hyperion init" first`);
  const config = await readYaml(path.join(root, 'hyperion.yaml'));
  const secretsFile = path.join(root, 'secrets.local.yaml');
  const fileSecrets = (await exists(secretsFile)) ? await readYaml(secretsFile) : {};
  return {
    root,
    config,
    secrets: {
      get: (name) => process.env[`HYPERION_SECRET_${name}`] ?? fileSecrets[name],
      has: (name) => process.env[`HYPERION_SECRET_${name}`] != null || (fileSecrets[name] != null && fileSecrets[name] !== ''),
      /** Write one secret to secrets.local.yaml (gitignored), keeping the file's other entries and comments. */
      async set(name, value) {
        // a new file starts as a block mapping (an empty "{}" would make every later key one-line flow style)
        const doc = (await exists(secretsFile))
          ? YAML.parseDocument(await readFile(secretsFile, 'utf8'))
          : YAML.parseDocument(`# Written by hyperion — gitignored, never commit\n${YAML.stringify({ [name]: value })}`);
        doc.set(name, value);
        await writeFile(secretsFile, doc.toString(), 'utf8');
        fileSecrets[name] = value;
      },
    },
  };
}

export async function loadEnv(project, name) {
  name ??= project.config.defaultEnv;
  if (!name) throw new Error('No environment given — pass --env <name> or set defaultEnv in hyperion.yaml');
  const file = path.join(project.root, 'envs', `${name}.env.yaml`);
  if (!(await exists(file))) throw new Error(`Environment not found: ${path.relative(project.root, file)}`);
  const localFile = path.join(project.root, 'envs', `${name}.local.env.yaml`);
  const base = await readYaml(file);
  const local = (await exists(localFile)) ? await readYaml(localFile) : {};
  return {
    name,
    file,
    localFile,
    title: base.metadata?.name ?? name,
    protected: base.protected === true,
    httpAllowlist: base.httpAllowlist,
    variables: base.variables ?? {},
    localVariables: local.variables ?? {},
  };
}

/** Persist variables into the gitignored local overlay (envs/<name>.local.env.yaml). */
export async function saveLocalEnvVars(env, updates) {
  const doc = (await exists(env.localFile)) ? await readYaml(env.localFile) : {};
  doc.apiVersion ??= 'hyperion/v3';
  doc.kind ??= 'EnvironmentLocal';
  doc.variables = { ...(doc.variables ?? {}), ...updates };
  for (const [k, v] of Object.entries(updates)) if (v == null) delete doc.variables[k];
  const header = '# Written by hyperion (tokens etc.) — gitignored, do not commit\n';
  await writeFile(env.localFile, header + YAML.stringify(doc), 'utf8');
  env.localVariables = doc.variables;
}

const collectionCache = new Map();

/** Drop cached _collection.yaml files (the UI calls this so edits on disk are picked up). */
export function forgetCollections() {
  collectionCache.clear();
}

async function loadCollectionAt(dir) {
  if (!collectionCache.has(dir)) {
    collectionCache.set(dir, readYaml(path.join(dir, '_collection.yaml')).then((config) => ({ dir, config })));
  }
  return collectionCache.get(dir);
}

/** Find the collection a path belongs to (walks up to the nearest _collection.yaml). */
export async function loadCollectionFor(p) {
  const s = await stat(p);
  const dir = await findUp(s.isFile() ? path.dirname(p) : p, '_collection.yaml');
  if (!dir) throw new Error(`No _collection.yaml above ${p}`);
  return loadCollectionAt(dir);
}

/** Load a request file plus its collection and the _folder.yaml chain between them. */
export async function loadRequest(file) {
  const request = await readYaml(file);
  const collection = await loadCollectionFor(file);
  const folders = [];
  let dir = path.dirname(path.resolve(file));
  while (dir.startsWith(collection.dir) && dir !== collection.dir) {
    const f = path.join(dir, '_folder.yaml');
    if (await exists(f)) folders.unshift(await readYaml(f));
    dir = path.dirname(dir);
  }
  return { file, request, collection, folders };
}

/** Expand files/directories into a sorted list of *.req.yaml files. */
export async function listRequestFiles(paths) {
  const out = [];
  const walk = async (p) => {
    const s = await stat(p);
    if (s.isFile()) return void out.push(path.resolve(p));
    const entries = (await readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.req.yaml')) out.push(path.resolve(full));
    }
  };
  for (const p of paths) await walk(p);
  return out;
}
