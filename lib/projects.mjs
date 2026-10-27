// Recently opened projects (any folder with a hyperion.yaml), kept per Windows user in ~/.hyperion/projects.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, readYaml } from './project.mjs';

const FILE = process.env.HYPERION_PROJECTS_FILE ?? path.join(os.homedir(), '.hyperion', 'projects.json');

async function read() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return { projects: [], last: null };
  }
}

async function write(data) {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** Known projects that still exist on disk, with their current names. */
export async function listProjects() {
  const data = await read();
  const out = [];
  for (const root of data.projects.map((p) => p.root)) {
    const cfg = path.join(root, 'hyperion.yaml');
    if (!(await exists(cfg))) continue;
    const c = await readYaml(cfg).catch(() => ({}));
    out.push({ root, name: c.name ?? path.basename(root) });
  }
  return { projects: out, last: out.some((p) => p.root === data.last) ? data.last : out[0]?.root ?? null };
}

export async function rememberProject(root) {
  const data = await read();
  data.projects = [{ root }, ...data.projects.filter((p) => p.root !== root)].slice(0, 30);
  data.last = root;
  await write(data);
}

export async function forgetProject(root) {
  const data = await read();
  data.projects = data.projects.filter((p) => p.root !== root);
  if (data.last === root) data.last = data.projects[0]?.root ?? null;
  await write(data);
}
