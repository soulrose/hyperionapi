// Flows: run requests from any collection in order, passing values along with $flow.set / pm.environment.set.
// File: flows/<name>.flow.yaml
//   metadata: { name }
//   steps:
//     - request: collections/main/login.req.yaml
//     - request: collections/main/get-patient.req.yaml
//       when: "$flow.get('TOKEN')"      # optional: run only when this is truthy
//       continueOnFail: true            # optional: keep going if this step fails
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import YAML from 'yaml';
import { exists, readYaml } from './project.mjs';
import { runRequest } from './runner.mjs';
import { slug } from './util.mjs';

const rel = (project, p) => path.relative(project.root, p).replaceAll(path.sep, '/');

export async function listFlows(project) {
  const dir = path.join(project.root, 'flows');
  if (!(await exists(dir))) return [];
  const out = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.flow.yaml')).sort()) {
    const doc = await readYaml(path.join(dir, f)).catch(() => ({}));
    out.push({ file: `flows/${f}`, name: doc.metadata?.name ?? f.replace('.flow.yaml', ''), steps: (doc.steps ?? []).length });
  }
  return out;
}

export async function createFlow(project, name) {
  if (!name?.trim()) throw new Error('Enter a flow name');
  const dir = path.join(project.root, 'flows');
  await mkdir(dir, { recursive: true });
  let file = path.join(dir, `${slug(name)}.flow.yaml`);
  for (let i = 2; await exists(file); i++) file = path.join(dir, `${slug(name)}-${i}.flow.yaml`);
  await writeFile(file, YAML.stringify({ apiVersion: 'hyperion/v3', kind: 'Flow', metadata: { name: name.trim() }, steps: [] }));
  return rel(project, file);
}

/** `when:` is a small JS expression over $flow / $env, e.g. "$flow.get('visitId') != null". */
function evalWhen(expr, flowVars, getVar) {
  try {
    return !!vm.runInNewContext(`(${expr})`, { $flow: { get: (k) => flowVars[k] }, $env: { get: getVar } }, { timeout: 1000 });
  } catch (err) {
    throw new Error(`when "${expr}": ${err.message}`);
  }
}

/**
 * Run every step in order. opts: { env, runtime, saveToken, log, onStep }.
 * A failed step stops the flow unless it has continueOnFail. Steps sent to a protected env are guarded by
 * runRequest (mutations are blocked without confirmation), so a flow never writes to prod by itself.
 */
export async function runFlow(project, file, opts) {
  const abs = path.resolve(project.root, file);
  if (!abs.startsWith(project.root)) throw new Error('flow outside project');
  const doc = await readYaml(abs);
  const steps = doc.steps ?? [];
  const flowVars = {};
  const runtime = opts.runtime ?? {};
  const getVar = (k) => runtime[k] ?? opts.env.localVariables?.[k] ?? opts.env.variables?.[k];
  const results = [];
  let stopped = null;
  for (const [index, step] of steps.entries()) {
    const reqFile = path.resolve(project.root, step.request ?? '');
    const base = { index, request: step.request };
    if (!step.request || !(await exists(reqFile))) {
      results.push({ ...base, name: step.request ?? '(no request)', passed: false, error: `File not found: ${step.request}`, tests: [], warnings: [] });
      if (!step.continueOnFail) {
        stopped = index;
        break;
      }
      continue;
    }
    if (step.when && !evalWhen(step.when, flowVars, getVar)) {
      results.push({ ...base, name: step.name ?? step.request, skipped: true, tests: [], warnings: [] });
      opts.onStep?.(results.at(-1));
      continue;
    }
    const r = await runRequest(reqFile, { project, env: opts.env, flow: flowVars, runtime, saveToken: opts.saveToken, log: opts.log, confirm: opts.confirm });
    results.push({ ...base, ...r });
    opts.onStep?.(results.at(-1));
    if (!r.passed && !step.continueOnFail) {
      stopped = index;
      break;
    }
  }
  return {
    name: doc.metadata?.name ?? path.basename(file, '.flow.yaml'),
    results,
    stoppedAt: stopped,
    passed: stopped == null && results.every((r) => r.passed || r.skipped || steps[r.index]?.continueOnFail),
    flow: flowVars,
  };
}
