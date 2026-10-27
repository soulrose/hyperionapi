#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getIntrospectionQuery, buildClientSchema, printSchema } from 'graphql';
import { loadProject, loadEnv, listRequestFiles, loadCollectionFor } from '../lib/project.mjs';
import { createVars } from '../lib/vars.mjs';
import { runRequest } from '../lib/runner.mjs';
import { syncSchema } from '../lib/schema.mjs';
import { resolveAuth, getToken, tokenState, clearToken } from '../lib/auth.mjs';
import { printResult, printSummary, junit } from '../lib/report.mjs';
import { readDataFile } from '../lib/csv.mjs';
import { send } from '../lib/http.mjs';
import { introspectionRejection } from '../lib/schema.mjs';
import { init } from '../lib/init.mjs';

const HELP = `hyperion — schema from Dev, execute on Prod

  hyperion init [dir]                                   scaffold a project
  hyperion run <file|dir>... [--env uat] [options]      run *.req.yaml
      --var K=V            runtime variable (repeatable)
      --data rows.csv      data-driven run (blocked on protected envs)
      --confirm <OpName>   allow this mutation on a protected env
      --reporter junit --out report.xml
      -v, --verbose        print (masked) response   --unmask  show PHI
      --no-save-token      keep refreshed tokens in memory only (default on CI)
      --no-validate        skip local schema validation
  hyperion flow run <flows/x.flow.yaml> [--env dev] [--reporter junit --out f]   run a flow's blocks in order
  hyperion schema sync <collectionDir> [--env] [--snapshot] [--reprobe]
  hyperion schema export --url <graphql-url> [-H "K: V"]... --out schema.graphql
  hyperion token <status|refresh|clear> <collectionDir> [--env]
  hyperion import <postman.json>... [--project dir]     Postman collection / environment
  hyperion import --postman-desktop [--env dev] [--project dir]   GraphQL requests straight from the Postman app
  hyperion new collection "<name>" [--url U] [--from collections/x] [--project dir]
  hyperion new request <collectionDir> "<name>" [--folder f] [--rest --method GET --url U]
  hyperion move <file.req.yaml> <collectionDir> [--folder f]     move a request to another collection
  hyperion split <folderDir> ["<new collection name>"]          turn a folder into its own collection
  hyperion serve [dir] [--port 4321] [--open]           web UI (no dir = last project; switch projects in the UI)
  hyperion demo [--open]                                UI against a built-in mock API
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string', short: 'e' },
    var: { type: 'string', multiple: true },
    data: { type: 'string' },
    confirm: { type: 'string' },
    reporter: { type: 'string' },
    out: { type: 'string', short: 'o' },
    verbose: { type: 'boolean', short: 'v' },
    unmask: { type: 'boolean' },
    'no-save-token': { type: 'boolean' },
    'no-validate': { type: 'boolean' },
    snapshot: { type: 'boolean' },
    reprobe: { type: 'boolean' },
    url: { type: 'string' },
    header: { type: 'string', short: 'H', multiple: true },
    port: { type: 'string' },
    open: { type: 'boolean' },
    project: { type: 'string' },
    'postman-desktop': { type: 'boolean' },
    from: { type: 'string' },
    folder: { type: 'string' },
    rest: { type: 'boolean' },
    method: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...args] = positionals;
const log = (m) => console.log(m);
const saveToken = !o['no-save-token'] && !process.env.CI;

async function main() {
  if (!cmd || o.help) return void console.log(HELP);

  if (cmd === 'init') {
    const dir = path.resolve(args[0] ?? '.');
    const created = await init(dir);
    console.log(created.length ? `created in ${dir}:\n  ${created.join('\n  ')}` : 'nothing to do — files already exist');
    return;
  }

  if (cmd === 'serve') {
    const { serve } = await import('../lib/server.mjs');
    return serve({ dir: args[0] ? path.resolve(args[0]) : undefined, port: Number(o.port ?? 4321), open: o.open });
  }

  if (cmd === 'demo') {
    const { demo } = await import('../lib/demo.mjs');
    return demo({ dir: path.resolve(args[0] ?? path.join(import.meta.dirname, '..', '.demo')), port: Number(o.port ?? 4322), open: o.open });
  }

  if (cmd === 'new') {
    const { createCollection, createRequest } = await import('../lib/scaffold.mjs');
    const project = await loadProject(o.project ?? process.cwd());
    if (args[0] === 'collection') {
      const c = await createCollection(project, { name: args[1], url: o.url, from: o.from });
      return log(`✔ collection "${c.name}" → ${c.dir}/_collection.yaml`);
    }
    if (args[0] === 'request') {
      const colDir = path.relative(project.root, path.resolve(args[1] ?? ''));
      const file = await createRequest(project, { collection: colDir, name: args[2], folder: o.folder, kind: o.rest ? 'HttpRequest' : 'GraphQLRequest', method: o.method, url: o.url });
      return log(`✔ ${file}`);
    }
    throw new Error('new: use "new collection <name>" or "new request <collectionDir> <name>"');
  }

  if (cmd === 'move' || cmd === 'split') {
    const { moveRequest, splitFolder } = await import('../lib/scaffold.mjs');
    const project = await loadProject(o.project ?? args[0] ?? process.cwd());
    const r = (p) => path.relative(project.root, path.resolve(p ?? ''));
    if (cmd === 'move') return log(`✔ moved → ${await moveRequest(project, { file: r(args[0]), collection: r(args[1]), folder: o.folder })}`);
    const s = await splitFolder(project, { folder: r(args[0]), name: args[1] });
    return log(`✔ new collection "${s.name}" → ${s.dir}/ (${s.moved} requests moved, auth/schema copied from the parent)`);
  }

  if (cmd === 'import' && o['postman-desktop']) {
    const { importPostmanDesktop } = await import('../lib/import-postman-desktop.mjs');
    const project = await loadProject(o.project ?? process.cwd());
    for (const r of await importPostmanDesktop(project, { envName: o.env })) {
      log(`${r.collection} → ${r.dir}: ${r.created} new, ${r.updated} updated${r.namesOnly.length ? `, ${r.namesOnly.length} not opened in Postman yet` : ''}`);
      for (const n of r.notes) log(`  note: ${n}`);
    }
    return;
  }

  if (cmd === 'import') {
    const { importPostman } = await import('../lib/import-postman.mjs');
    const project = await loadProject(o.project ?? process.cwd());
    for (const f of args) {
      const r = await importPostman(project, JSON.parse(await readFile(f, 'utf8')), { fileName: path.basename(f) });
      log(`✔ ${f} → ${r.summary}`);
      for (const n of r.notes) log(`  note: ${n}`);
    }
    return;
  }

  if (cmd === 'schema' && args[0] === 'export') return schemaExport();

  const project = await loadProject(args.at(-1) ?? process.cwd());
  const env = await loadEnv(project, o.env);
  if (env.protected) log(`env "${env.title}" is protected`);

  if (cmd === 'flow') {
    if (args[0] !== 'run' || !args[1]) throw new Error('flow: use "hyperion flow run <flows/x.flow.yaml> [--env dev]"');
    const { runFlow } = await import('../lib/flow.mjs');
    const r = await runFlow(project, path.relative(project.root, path.resolve(args[1])), {
      env,
      saveToken,
      log,
      onStep: (s) => (s.skipped ? log(`- ${s.name}  (skipped: when)`) : printResult(s, { verbose: o.verbose, unmask: o.unmask })),
    });
    if (r.stoppedAt != null) log(`flow stopped at block ${r.stoppedAt + 1}`);
    printSummary(r.results.filter((x) => !x.skipped));
    if (o.reporter === 'junit') {
      const out = o.out ?? 'hyperion-report.xml';
      await writeFile(out, junit(r.results.filter((x) => !x.skipped), r.name), 'utf8');
      log(`JUnit report: ${out}`);
    }
    process.exitCode = r.passed ? 0 : 1;
    return;
  }

  if (cmd === 'run') {
    if (!args.length) throw new Error('run: give at least one file or directory');
    const files = await listRequestFiles(args);
    const runtime = Object.fromEntries((o.var ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    const rows = o.data ? await readDataFile(o.data) : [{}];
    if (o.data && env.protected) throw new Error(`data-driven runs are blocked on protected env "${env.name}"`);
    const results = [];
    for (const [idx, data] of rows.entries()) {
      if (o.data) log(`\n— row ${idx + 1}/${rows.length}`);
      const flow = {};
      for (const file of files) {
        const r = await runRequest(file, { project, env, data, flow, runtime, saveToken, confirm: o.confirm, log, validate: !o['no-validate'] });
        const collection = await loadCollectionFor(file);
        printResult(r, { verbose: o.verbose, unmask: o.unmask, maskFields: collection.config.masking?.fields });
        results.push(r);
      }
    }
    printSummary(results);
    if (o.reporter === 'junit') {
      const out = o.out ?? 'hyperion-report.xml';
      await writeFile(out, junit(results), 'utf8');
      log(`JUnit report: ${out}`);
    }
    process.exitCode = results.every((r) => r.passed) ? 0 : 1;
    return;
  }

  const collection = await loadCollectionFor(args[1] ?? args[0] ?? '.');
  const vars = createVars({ global: project.config.variables, collection: collection.config.variables, env, secrets: project.secrets });
  const ctx = { project, env, collection, vars, saveToken, log, plane: 'execution' };

  if (cmd === 'schema' && args[0] === 'sync') {
    await syncSchema(ctx, { snapshot: o.snapshot, reprobe: o.reprobe });
    return;
  }

  if (cmd === 'token') {
    const auth = resolveAuth(collection.config.execution?.auth);
    if (auth?.type !== 'tokenEndpoint') throw new Error('collection execution.auth is not tokenEndpoint');
    const cfg = auth.tokenEndpoint ?? auth;
    if (args[0] === 'refresh') await getToken(cfg, ctx, { force: true });
    else if (args[0] === 'clear') {
      await clearToken(cfg, ctx);
      return log('token cleared');
    }
    const st = tokenState(cfg, ctx);
    if (!st.token) return log('no token');
    const left = st.expMs ? Math.round((st.expMs - Date.now()) / 60000) : null;
    log(`${st.names.accessToken}: ${left == null ? 'expiry unknown' : left > 0 ? `valid, ${left} min left` : 'EXPIRED'}${st.refreshToken ? ' · refresh token present' : ''}`);
    return;
  }

  throw new Error(`unknown command "${cmd}"\n${HELP}`);
}

/** P0: dump SDL from any GraphQL endpoint, no project needed. */
async function schemaExport() {
  if (!o.url) throw new Error('schema export: --url is required');
  const headers = { 'Content-Type': 'application/json' };
  for (const h of o.header ?? []) {
    const i = h.indexOf(':');
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const res = await send({ method: 'POST', url: o.url, headers, body: JSON.stringify({ query: getIntrospectionQuery() }), timeoutMs: 30000 });
  const reason = introspectionRejection(res);
  if (reason) throw new Error(`introspection rejected by ${o.url}: ${reason}`);
  const sdl = printSchema(buildClientSchema(res.json.data));
  const out = o.out ?? 'schema.graphql';
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, `# source: ${o.url}\n# fetched: ${new Date().toISOString()}\n${sdl}\n`, 'utf8');
  log(`wrote ${out} (${sdl.length} chars)`);
}

main().catch((err) => {
  console.error(`✘ ${err.message}`);
  process.exitCode = 1;
});
