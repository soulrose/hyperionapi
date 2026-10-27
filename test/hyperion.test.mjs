import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { startMocks } from '../lib/mock-servers.mjs';
import { writeSample } from '../lib/sample.mjs';
import { loadProject, loadEnv, loadCollectionFor } from '../lib/project.mjs';
import { createVars, interpolate } from '../lib/vars.mjs';
import { runRequest } from '../lib/runner.mjs';
import { syncSchema } from '../lib/schema.mjs';
import { parseCsv } from '../lib/csv.mjs';
import { maskDeep } from '../lib/util.mjs';

let mocks;
process.env.HYPERION_SECRET_PROD_PASSWORD = 'pw';
process.env.HYPERION_SECRET_DEV_INTROSPECTION_KEY = 'dev-key';

before(async () => {
  mocks = await startMocks({ tokenTtlSec: 3600 });
});
after(() => mocks.close());

async function makeProject({ protectedEnv = false, tokenTtl } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hyperion-'));
  await writeSample(dir, mocks);
  const env = {
    apiVersion: 'hyperion/v3',
    kind: 'Environment',
    metadata: { name: 'Mock' },
    protected: protectedEnv,
    variables: {
      GQL_URL: `${mocks.prodUrl}/graphql`,
      AUTH_URL: `${mocks.prodUrl}/api/auth/token`,
      SCHEMA_URL: `${mocks.devUrl}/graphql`,
      APP_USER: 'svc-hyperion',
      APP_PASSWORD: '{{secret:PROD_PASSWORD}}',
      UNIT_CODE: 'OPD',
      TARGET_HN: '123',
    },
  };
  await writeFile(path.join(dir, 'envs/mock.env.yaml'), YAML.stringify(env));
  if (tokenTtl != null) {
    const f = path.join(dir, 'collections/sample/_collection.yaml');
    const c = YAML.parse(await readFile(f, 'utf8'));
    c.execution.auth.tokenEndpoint.expiresIn = tokenTtl;
    await writeFile(f, YAML.stringify(c));
  }
  const project = await loadProject(dir);
  const loadedEnv = await loadEnv(project, 'mock');
  const reqFile = path.join(dir, 'collections/sample/patient/get-patient.req.yaml');
  const collection = await loadCollectionFor(reqFile);
  const run = (file = reqFile, extra = {}) =>
    runRequest(file, { project, env: loadedEnv, flow: {}, runtime: {}, saveToken: true, ...extra });
  return { dir, project, env: loadedEnv, collection, reqFile, run };
}

async function writeReq(dir, name, body) {
  const f = path.join(dir, 'collections/sample/patient', `${name}.req.yaml`);
  await writeFile(f, YAML.stringify(body));
  return f;
}

test('schema: Prod rejects introspection (200 + errors) → falls back to Dev, and remembers', async () => {
  const p = await makeProject();
  const logs = [];
  const ctx = { project: p.project, env: p.env, collection: p.collection, vars: createVars({ env: p.env, secrets: p.project.secrets }), saveToken: true, log: (m) => logs.push(m) };
  const { meta } = await syncSchema(ctx);
  assert.equal(meta.source, 'fallback');
  assert.ok(logs.some((l) => l.includes('GraphQL introspection is not allowed')));

  logs.length = 0;
  await syncSchema(ctx);
  assert.ok(logs.some((l) => l.includes('known disabled')), 'second sync skips Prod');
});

test('run: executes on Prod, tests pass, token saved to local env overlay', async () => {
  const p = await makeProject();
  const r = await p.run();
  assert.equal(r.error, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.tests.map((t) => t.pass), [true, true]);
  assert.ok(r.passed);
  const local = YAML.parse(await readFile(path.join(p.dir, 'envs/mock.local.env.yaml'), 'utf8'));
  assert.match(local.variables.ACCESS_TOKEN, /\./);
  assert.match(local.variables.REFRESH_TOKEN, /^rt-/);
  assert.ok(Date.parse(local.variables.TOKEN_EXPIRES_AT) > Date.now());
});

test('token: expired → refresh endpoint (not login), new values written to env', async () => {
  const p = await makeProject({ tokenTtl: 30 }); // 30s < 60s skew → always "about to expire"
  const loginBefore = mocks.stats.login;
  const refreshBefore = mocks.stats.refresh;
  await p.run();
  const first = YAML.parse(await readFile(p.env.localFile, 'utf8')).variables.ACCESS_TOKEN;
  const r = await p.run();
  assert.ok(r.passed);
  assert.equal(mocks.stats.login - loginBefore, 1);
  assert.equal(mocks.stats.refresh - refreshBefore, 1);
  const second = YAML.parse(await readFile(p.env.localFile, 'utf8')).variables.ACCESS_TOKEN;
  assert.notEqual(first, second);
});

test('token: 401 (revoked before exp) → refresh and retry once', async () => {
  const p = await makeProject();
  await p.run();
  mocks.revokeAll();
  const r = await p.run();
  assert.equal(r.status, 200);
  assert.ok(r.passed);
});

test('token: concurrent requests share one login (single-flight)', async () => {
  const p = await makeProject();
  const before = mocks.stats.login;
  const results = await Promise.all(Array.from({ length: 5 }, () => p.run()));
  assert.ok(results.every((r) => r.passed));
  assert.equal(mocks.stats.login - before, 1);
});

test('drift: field exists in Dev schema but Prod rejects it → warning', async () => {
  const p = await makeProject();
  const ctx = { project: p.project, env: p.env, collection: p.collection, vars: createVars({ env: p.env, secrets: p.project.secrets }), saveToken: true };
  await syncSchema(ctx);
  const f = await writeReq(p.dir, 'allergy', {
    kind: 'GraphQLRequest',
    metadata: { name: 'Allergy' },
    payload: { query: 'query A($hn: String!) { patient(hn: $hn) { allergyList { drugName } } }', variables: { hn: '1' } },
  });
  const r = await p.run(f);
  assert.equal(r.warnings.filter((w) => w.startsWith('schema (')).length, 0, 'valid against Dev');
  assert.ok(r.warnings.some((w) => w.includes('schema drift')));
  assert.equal(r.passed, false, 'GraphQL errors without tests = failed');
});

test('prod guard: mutation on protected env is blocked unless confirmed', async () => {
  const p = await makeProject({ protectedEnv: true });
  const f = await writeReq(p.dir, 'rx', {
    kind: 'GraphQLRequest',
    metadata: { name: 'Prescribe' },
    payload: { operationName: 'Rx', query: 'mutation Rx { createPrescription(visitId: "V-1", drug: "x") { id } }' },
  });
  const calls = mocks.stats.prodCalls;
  const blocked = await p.run(f);
  assert.ok(blocked.blocked);
  assert.equal(mocks.stats.prodCalls, calls, 'nothing sent');
  const ok = await p.run(f, { confirm: 'Rx' });
  assert.equal(ok.status, 200);
  assert.equal(ok.response.json.data.createPrescription.id, 'RX-1');
});

test('tests: null patient fails toBeTruthy (V3 toBeDefined bug)', async () => {
  const p = await makeProject();
  const r = await p.run(p.reqFile, { runtime: { TARGET_HN: '404' } });
  assert.equal(r.passed, false);
  assert.equal(r.tests[1].pass, false);
});

test('vars: precedence, typed whole placeholders, secrets, missing', () => {
  const vars = createVars({
    global: { A: 'g', N: 1 },
    collection: { A: 'c' },
    env: { variables: { A: 'e', P: '{{secret:S}}' }, localVariables: {} },
    runtime: {},
    secrets: { get: (k) => (k === 'S' ? 'shh' : undefined) },
  });
  assert.equal(vars.get('A'), 'e');
  assert.equal(vars.whereIs('A'), 'env');
  const missing = [];
  assert.deepEqual(interpolate({ n: '{{N}}', s: 'x-{{A}}', p: '{{P}}', m: '{{NOPE}}' }, vars, missing), { n: 1, s: 'x-e', p: 'shh', m: '{{NOPE}}' });
  assert.deepEqual(missing, ['NOPE']);
});

test('csv + masking', () => {
  assert.deepEqual(parseCsv('hn,name\n1,"a, b"\n2,"say ""hi"""\n'), [['hn', 'name'], ['1', 'a, b'], ['2', 'say "hi"']]);
  assert.deepEqual(maskDeep({ patient: { hn: '1', firstName: 'สมชาย' } }, ['firstName']), { patient: { hn: '1', firstName: 'ส●●●●' } });
});

test('import: Postman collection (graphql + REST + pm scripts) and environment (secrets moved out)', async () => {
  const { importPostman } = await import('../lib/import-postman.mjs');
  const p = await makeProject();
  const col = {
    info: { name: 'Shop Postman', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{ACCESS_TOKEN}}' }] },
    variable: [{ key: 'hn', value: '123' }],
    item: [
      {
        name: 'Patient',
        item: [
          {
            name: 'Get patient',
            request: {
              method: 'POST',
              url: { raw: '{{GQL_URL}}' },
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'graphql', graphql: { query: 'query P($hn: String!) { patient(hn: $hn) { hn } }', variables: '{"hn": "{{hn}}"}' } },
            },
            event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200);', '  pm.expect(pm.response.json().data.patient.hn).to.eql("123");', '  pm.environment.set("SEEN", "1");', '});'] } }],
          },
        ],
      },
      { name: 'Login', request: { method: 'POST', url: '{{AUTH_URL}}', body: { mode: 'raw', raw: '{"username":"{{APP_USER}}","password":"{{APP_PASSWORD}}"}', options: { raw: { language: 'json' } } }, auth: { type: 'noauth' } } },
    ],
  };
  const r = await importPostman(p.project, col);
  assert.equal(r.count, 2);
  const c = YAML.parse(await readFile(path.join(p.dir, r.dir, '_collection.yaml'), 'utf8'));
  assert.equal(c.execution.url, '{{GQL_URL}}');
  assert.equal(c.execution.auth.type, 'bearer');
  const gqlFile = path.join(p.dir, r.dir, 'patient/get-patient.req.yaml');
  const g = YAML.parse(await readFile(gqlFile, 'utf8'));
  assert.equal(g.kind, 'GraphQLRequest');
  assert.deepEqual(g.payload.variables, { hn: '{{hn}}' });
  assert.equal(g.execution, undefined, 'shared URL lifted to the collection, Content-Type dropped');

  // run the imported request: token from a login request first, then the pm.* test passes
  const login = await p.run(path.join(p.dir, r.dir, 'login.req.yaml'));
  assert.equal(login.status, 200);
  const runtime = { ACCESS_TOKEN: login.response.json.accessToken };
  const res = await p.run(gqlFile, { runtime });
  assert.deepEqual(res.tests, [{ name: 'ok', pass: true }]);
  assert.equal(runtime.SEEN, '1');

  const env = await importPostman(p.project, {
    name: 'Shop Prod',
    values: [{ key: 'GQL_URL', value: 'https://x/graphql', enabled: true }, { key: 'password', value: 's3cret', type: 'secret', enabled: true }],
  });
  const e = YAML.parse(await readFile(path.join(p.dir, 'envs', `${env.env}.env.yaml`), 'utf8'));
  assert.equal(e.protected, true);
  assert.equal(e.variables.password, '{{secret:PASSWORD}}');
  const secrets = YAML.parse(await readFile(path.join(p.dir, 'secrets.local.yaml'), 'utf8'));
  assert.equal(secrets.PASSWORD, 's3cret');
});

test('pm shim: chai subset', async () => {
  const { chaiExpect } = await import('../lib/pm-shim.mjs');
  chaiExpect([1, 2]).to.be.an('array').that.is.not.empty;
  chaiExpect({ a: { b: 1 } }).to.have.property('a').that.deep.equals({ b: 1 });
  chaiExpect({ a: 1 }).to.deep.equal({ a: 1 });
  chaiExpect('hello').to.include('ell');
  chaiExpect(5).to.be.above(3).and.below(9);
  assert.throws(() => chaiExpect(null).to.be.ok, /expected null to be ok/);
  assert.throws(() => chaiExpect(1).to.not.equal(1), /not to equal/);
});

test('collections: create (copy auth from existing), new request, move, split folder', async () => {
  const { createCollection, createRequest, moveRequest, splitFolder, listCollections } = await import('../lib/scaffold.mjs');
  const { forgetCollections } = await import('../lib/project.mjs');
  const p = await makeProject();

  const c = await createCollection(p.project, { name: 'Pharmacy API', from: 'collections/sample' });
  assert.equal(c.dir, 'collections/pharmacy-api');
  const col = YAML.parse(await readFile(path.join(p.dir, c.dir, '_collection.yaml'), 'utf8'));
  assert.equal(col.execution.auth.type, 'tokenEndpoint', 'auth copied');
  assert.equal(col.schemaDiscovery.offlineSnapshot, '../../schemas/sample.snapshot.graphql');

  const f = await createRequest(p.project, { collection: c.dir, name: 'List drugs', folder: 'stock' });
  assert.equal(f, 'collections/pharmacy-api/stock/list-drugs.req.yaml');
  assert.match(YAML.parse(await readFile(path.join(p.dir, f), 'utf8')).payload.query, /^query ListDrugs \{/);

  const moved = await moveRequest(p.project, { file: 'collections/sample/patient/get-patient.req.yaml', collection: c.dir });
  assert.equal(moved, 'collections/pharmacy-api/get-patient.req.yaml');
  forgetCollections();
  const r = await p.run(path.join(p.dir, moved));
  assert.ok(r.passed, 'moved request runs with the new collection auth');

  // split: a folder with its own _folder.yaml becomes a collection
  const folder = path.join(p.dir, 'collections/sample/lab');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, '_folder.yaml'), YAML.stringify({ variables: { LAB_HN: '777' }, headers: { 'X-Lab': '1' } }));
  await writeReq(p.dir, '../lab/lab-patient', { kind: 'GraphQLRequest', metadata: { name: 'Lab patient' }, payload: { query: 'query L($hn: String!) { patient(hn: $hn) { hn } }', variables: { hn: '{{LAB_HN}}' } } });
  const s = await splitFolder(p.project, { folder: 'collections/sample/lab', name: 'Lab API' });
  assert.equal(s.moved, 1);
  const lab = YAML.parse(await readFile(path.join(p.dir, s.dir, '_collection.yaml'), 'utf8'));
  assert.equal(lab.variables.LAB_HN, '777');
  assert.equal(lab.execution.headers['X-Lab'], '1');
  assert.equal(lab.execution.headers['X-Unit'], '{{UNIT_CODE}}', 'parent headers kept');
  forgetCollections();
  const lr = await p.run(path.join(p.dir, s.dir, 'lab-patient.req.yaml'));
  assert.equal(lr.response.json.data.patient.hn, '777');
  assert.deepEqual((await listCollections(p.project)).map((x) => x.name), ['Lab API', 'Pharmacy API', 'Sample API']);
});

test('schema: env that hides its schema borrows dev (network and cache)', async () => {
  const p = await makeProject();
  // dev env points at the dev mock; mock env has no SCHEMA_URL, so only the dev env can supply the schema
  const devFile = path.join(p.dir, 'envs/dev.env.yaml');
  const dev = YAML.parse(await readFile(devFile, 'utf8'));
  dev.variables.GQL_URL = `${mocks.devUrl}/graphql`;
  await writeFile(devFile, YAML.stringify(dev));
  const mockFile = path.join(p.dir, 'envs/mock.env.yaml');
  const m = YAML.parse(await readFile(mockFile, 'utf8'));
  delete m.variables.SCHEMA_URL;
  await writeFile(mockFile, YAML.stringify(m));
  const { loadSchema, forgetSchemas } = await import('../lib/schema.mjs');
  const env = await loadEnv(p.project, 'mock');
  const logs = [];
  const ctx = { project: p.project, env, collection: p.collection, vars: createVars({ env, secrets: p.project.secrets }), saveToken: true, log: (l) => logs.push(l) };
  const { meta } = await syncSchema(ctx);
  assert.equal(meta.source, 'dev', logs.join(' | '));

  // a third env that never synced borrows dev's cache without touching the network
  const devEnv = await loadEnv(p.project, 'dev');
  await syncSchema({ ...ctx, env: devEnv, vars: createVars({ env: devEnv, secrets: p.project.secrets }) });
  forgetSchemas();
  const training = await loadEnv(p.project, 'training');
  const s = await loadSchema({ ...ctx, env: training });
  assert.equal(s.meta.source, 'dev');
  assert.equal(s.meta.borrowed, true);
});

test('request-level Bearer token (Authorization tab) overrides the collection login', async () => {
  const p = await makeProject();
  await p.run(); // collection login → token in env.local
  const token = YAML.parse(await readFile(p.env.localFile, 'utf8')).variables.ACCESS_TOKEN;
  const loginsBefore = mocks.stats.login;
  const ok = await p.run(p.reqFile, { runtime: { bearer_token_11wx: token }, override: { auth: { type: 'bearer', bearer: { token: '{{bearer_token_11wx}}' } }, headers: { 'X-Trace': '1' } } });
  assert.equal(ok.status, 200);
  assert.equal(mocks.stats.login, loginsBefore, 'no login: the request used its own token');
  const bad = await p.run(p.reqFile, { override: { auth: { type: 'bearer', bearer: { token: 'wrong' } } } });
  assert.equal(bad.status, 401);
});

test('schema explorer: tick / untick fields edits the query, required args become variables', async () => {
  const { buildSchema } = await import('graphql');
  const { toggleField, selectedPaths, fieldsAt } = await import('../lib/builder.mjs');
  const schema = buildSchema(`
    type Visit { visitId: ID!, department: String }
    type Patient { hn: String!, firstName: String, visits(date: String): [Visit!]! }
    type Query { patient(hn: String!): Patient, ping: String }
    type Mutation { createPrescription(visitId: ID!, drug: String!): Visit }`);
  assert.deepEqual(fieldsAt(schema, 'query', []).map((f) => f.name), ['patient', 'ping']);
  assert.equal(fieldsAt(schema, 'query', ['patient']).find((f) => f.name === 'visits').leaf, false);

  let r = toggleField(schema, '', 'query', ['patient'], true); // object field: gets $hn and a first scalar
  assert.deepEqual(r.added, { hn: '' });
  assert.match(r.query, /query Patient\(\$hn: String!\) \{\s+patient\(hn: \$hn\) \{\s+hn\s+\}/);
  r = toggleField(schema, r.query, 'query', ['patient', 'visits', 'department'], true);
  assert.deepEqual(selectedPaths(r.query).paths, ['query:patient', 'query:patient.hn', 'query:patient.visits', 'query:patient.visits.department']);
  r = toggleField(schema, r.query, 'query', ['patient', 'visits', 'department'], false); // last child → parent goes too
  assert.deepEqual(selectedPaths(r.query).paths, ['query:patient', 'query:patient.hn']);
  r = toggleField(schema, r.query, 'query', ['patient'], false);
  assert.equal(r.query, '');
  assert.deepEqual(r.removed, ['hn']);
  r = toggleField(schema, '', 'mutation', ['createPrescription'], true);
  assert.deepEqual(Object.keys(r.added), ['visitId', 'drug']);
  assert.match(r.query, /^mutation CreatePrescription/);
});

test('flow: blocks run in order, $flow passes values, when / continueOnFail, prod stops at a mutation', async () => {
  const { createFlow, runFlow } = await import('../lib/flow.mjs');
  const p = await makeProject();
  const file = await createFlow(p.project, 'Patient then prescribe');
  const write = (steps) => writeFile(path.join(p.dir, file), YAML.stringify({ apiVersion: 'hyperion/v3', kind: 'Flow', metadata: { name: 'x' }, steps }));
  await write([
    { request: 'collections/sample/patient/get-patient.req.yaml' },
    { request: 'collections/sample/patient/patient-allergies.req.yaml', continueOnFail: true }, // fails (dev-only field) but goes on
    { request: 'collections/sample/pharmacy/create-prescription.req.yaml', when: "$flow.get('LATEST_VISIT_ID')" },
  ]);
  const r = await runFlow(p.project, file, { env: p.env, saveToken: true });
  assert.deepEqual(r.results.map((x) => [x.name, !!x.passed]), [['Get Patient', true], ['Patient Allergies (dev schema only)', false], ['Create Prescription', true]]);
  assert.equal(r.flow.LATEST_VISIT_ID, 'V-1');
  assert.equal(r.results[2].response.json.data.createPrescription.visitId, 'V-1');
  assert.equal(r.passed, true);

  await write([{ request: 'collections/sample/patient/get-patient.req.yaml' }, { request: 'collections/sample/pharmacy/create-prescription.req.yaml', when: "$flow.get('NOPE')" }]);
  const skipped = await runFlow(p.project, file, { env: p.env, saveToken: true });
  assert.equal(skipped.results[1].skipped, true);

  await write([{ request: 'collections/sample/pharmacy/create-prescription.req.yaml' }, { request: 'collections/sample/patient/get-patient.req.yaml' }]);
  const prod = await loadEnv(p.project, 'prod');
  const guarded = await runFlow(p.project, file, { env: prod, saveToken: true });
  assert.equal(guarded.stoppedAt, 0);
  assert.equal(guarded.results[0].blocked, true);
  assert.equal(guarded.results.length, 1);
});

test('paste import: cURL (bash and Windows cmd) and a bare GraphQL query', async () => {
  const { importPaste, parseCurl } = await import('../lib/import-paste.mjs');
  const c = parseCurl(`curl --location 'https://api-dev.example/graphql' \\n  --header 'Content-Type: application/json' \\n  --header 'Authorization: Bearer abc.def' \\n  --data '{"query":"query Api { api { id } }","variables":{}}'`);
  assert.equal(c.url, 'https://api-dev.example/graphql');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, 'Bearer abc.def');
  const win = parseCurl('curl "https://x.example/api" -H "X-A: 1" --data-raw "{^"a^":1}"');
  assert.equal(win.body, '{"a":1}');

  const p = await makeProject();
  const dev = path.join(p.dir, 'envs/dev.env.yaml');
  const d = YAML.parse(await readFile(dev, 'utf8'));
  d.variables.GQL_URL = 'https://<dev-host>/graphql'; // still the template placeholder
  await writeFile(dev, YAML.stringify(d));
  const r = await importPaste(p.project, {
    text: `curl 'https://api-dev.example/graphql' -H 'Authorization: Bearer abc.def' -H 'X-Unit: OPD' --data-raw '{"query":"query Api { api { id } }"}'`,
    collection: 'collections/sample',
    envName: 'dev',
  });
  const doc = YAML.parse(await readFile(path.join(p.dir, r.file), 'utf8'));
  assert.equal(doc.kind, 'GraphQLRequest');
  assert.equal(doc.metadata.name, 'Api');
  assert.deepEqual(doc.execution.auth, { type: 'bearer', bearer: { token: '{{BEARER_TOKEN}}' } });
  assert.deepEqual(doc.execution.headers, { 'X-Unit': 'OPD' });
  assert.equal(JSON.stringify(doc).includes('abc.def'), false, 'token not in the request file');
  assert.equal(YAML.parse(await readFile(path.join(p.dir, 'envs/dev.local.env.yaml'), 'utf8')).variables.BEARER_TOKEN, 'abc.def');
  assert.equal(YAML.parse(await readFile(dev, 'utf8')).variables.GQL_URL, 'https://api-dev.example/graphql');

  const q = await importPaste(p.project, { text: 'query Ping {\n  ping\n}', collection: 'collections/sample' });
  assert.equal(q.name, 'Ping');
  await assert.rejects(importPaste(p.project, { text: 'query {', collection: 'collections/sample' }), /Invalid GraphQL/);
});


test('prod guard: the app sends mutations without confirmation (confirm: true); a plain run is still blocked', async () => {
  const p = await makeProject({ protectedEnv: true });
  const f = path.join(p.dir, 'collections/sample/pharmacy/create-prescription.req.yaml');
  const blocked = await p.run(f, { runtime: { LATEST_VISIT_ID: 'V-1' } });
  assert.ok(blocked.blocked);
  const sent = await p.run(f, { runtime: { LATEST_VISIT_ID: 'V-1' }, confirm: true });
  assert.equal(sent.status, 200);
});

test('schema: 401 means "needs a token" — not remembered, and the request token is used once set', async () => {
  const p = await makeProject();
  // target = the prod mock (needs a bearer token); no SCHEMA_URL; dev env points at the dev mock
  const devFile = path.join(p.dir, 'envs/dev.env.yaml');
  const dev = YAML.parse(await readFile(devFile, 'utf8'));
  dev.variables.GQL_URL = `${mocks.devUrl}/graphql`;
  await writeFile(devFile, YAML.stringify(dev));
  const testFile = path.join(p.dir, 'envs/test.env.yaml');
  const t = YAML.parse(await readFile(testFile, 'utf8'));
  delete t.variables.SCHEMA_URL;
  await writeFile(testFile, YAML.stringify(t));
  const colFile = path.join(p.dir, 'collections/sample/_collection.yaml');
  const col = YAML.parse(await readFile(colFile, 'utf8'));
  col.execution.auth = 'none'; // like a project where only the request tab has a token
  col.execution.headers['X-Dev-Introspection-Key'] = 'dev-key'; // the dev mock wants this; a real dev server may not
  await writeFile(colFile, YAML.stringify(col));
  const { forgetCollections } = await import('../lib/project.mjs');
  forgetCollections();
  const collection = await loadCollectionFor(p.reqFile);
  const env = await loadEnv(p.project, 'test');
  const ctx = { project: p.project, env, collection, vars: createVars({ env, secrets: p.project.secrets }), saveToken: true };

  const first = await syncSchema(ctx);
  assert.equal(first.meta.source, 'dev');
  assert.equal(first.meta.targetRejected, 'HTTP 401');
  const state = JSON.parse(await readFile(path.join(p.dir, '.hyperion/state.json'), 'utf8'));
  assert.deepEqual(state.introspectionDisabled, {}, '401 is not remembered as "introspection disabled"');

  // with the request's own token the target is asked again: it answers (introspection off there) and is remembered
  const login = await fetch(`${mocks.prodUrl}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'svc-hyperion', password: 'pw' }) }).then((r) => r.json());
  const logs = [];
  const second = await syncSchema({ ...ctx, log: (l) => logs.push(l) }, { targetAuth: { type: 'bearer', bearer: { token: login.accessToken } } });
  assert.ok(logs.some((l) => l.includes('GraphQL introspection is not allowed')), logs.join(' | '));
  assert.equal(second.meta.targetRejected, 'GraphQL introspection is not allowed');
});

test('schema explorer: select all plain fields, pass arguments as variables', async () => {
  const { buildSchema } = await import('graphql');
  const { toggleAll, toggleArg, selectedPaths } = await import('../lib/builder.mjs');
  const schema = buildSchema(`
    type Name { first: String, last: String }
    type Patient { hn: String!, gender: String, age(asOf: String): Int, nameTh: Name, visits(limit: Int, from: String): [String] }
    type Query { patient(hn: String!, includeMerged: Boolean): Patient }`);
  let r = toggleAll(schema, '', 'query', ['patient'], true); // ticks hn, gender, age — not nameTh (object) or visits (list of scalars with args? no: optional args)
  const sel = selectedPaths(r.query).paths;
  assert.ok(['query:patient.hn', 'query:patient.gender', 'query:patient.age', 'query:patient.visits'].every((p) => sel.includes(p)), sel.join());
  assert.ok(!sel.includes('query:patient.nameTh'));
  assert.deepEqual(r.added, { hn: '' }); // the required $hn came with the field
  r = toggleAll(schema, r.query, 'query', ['patient'], false);
  assert.equal(r.query, '');

  // optional argument from the panel: becomes a variable; the selection shows which variable it uses
  let a = toggleArg(schema, '', 'query', ['patient'], 'includeMerged', true); // ticks patient first
  assert.equal(a.varName, 'includeMerged');
  assert.deepEqual(a.added, { hn: '', includeMerged: false });
  assert.deepEqual(selectedPaths(a.query).args['query:patient'], { hn: { var: 'hn' }, includeMerged: { var: 'includeMerged' } });
  // an argument on a nested field whose name clashes with a field (hn) still gets its own variable name
  a = toggleArg(schema, a.query, 'query', ['patient', 'visits'], 'limit', true);
  assert.equal(a.varName, 'limit');
  a = toggleArg(schema, a.query, 'query', ['patient', 'includeMerged'].slice(0, 1), 'includeMerged', false);
  assert.deepEqual(a.removed, ['includeMerged']);
  assert.ok(!a.query.includes('$includeMerged'));
  assert.ok(a.query.includes('$hn'), 'hn variable is still used, and the hn field name does not confuse the check');
});

test('Keycloak / OpenID login: form-encoded password grant, refresh with refresh_token, login again when refresh is dead', async () => {
  const { keycloakAuth } = await import('../lib/auth.mjs');
  const p = await makeProject({ tokenTtl: 30 }); // 30 s token < 30 s skew → every send renews
  const colFile = path.join(p.dir, 'collections/sample/_collection.yaml');
  const col = YAML.parse(await readFile(colFile, 'utf8'));
  col.execution.auth = keycloakAuth();
  col.execution.auth.tokenEndpoint.expiresIn = 10; // shorter than the 30 s skew → the next send must renew
  await writeFile(colFile, YAML.stringify(col));
  const envFile = path.join(p.dir, 'envs/mock.env.yaml');
  const env = YAML.parse(await readFile(envFile, 'utf8'));
  Object.assign(env.variables, { KC_TOKEN_URL: `${mocks.prodUrl}/realms/demo/protocol/openid-connect/token`, KC_CLIENT_ID: 'hyperion', KC_CLIENT_SECRET: '', KC_USERNAME: 'svc-hyperion', KC_PASSWORD: '{{secret:DEMO_PASSWORD}}' });
  await writeFile(envFile, YAML.stringify(env));
  const { forgetCollections } = await import('../lib/project.mjs');
  forgetCollections();
  const project = await loadProject(p.dir);
  const e = await loadEnv(project, 'mock');
  const run = () => runRequest(p.reqFile, { project, env: e, flow: {}, runtime: {}, saveToken: true });

  const s0 = { ...mocks.stats };
  const first = await run();
  assert.equal(first.status, 200, first.error ?? '');
  assert.equal(mocks.stats.kcLogin - s0.kcLogin, 1);
  assert.ok(mocks.stats.kcForm > s0.kcForm, 'sent as a form');
  const local = YAML.parse(await readFile(e.localFile, 'utf8')).variables;
  assert.match(local.REFRESH_TOKEN, /^rt-/);

  const second = await run(); // token about to expire → refresh_token grant, not a new login
  assert.equal(second.status, 200);
  assert.equal(mocks.stats.kcRefresh - s0.kcRefresh, 1);
  assert.equal(mocks.stats.kcLogin - s0.kcLogin, 1);

  mocks.revokeAll(); // refresh token dead too → falls back to a password login
  const third = await run();
  assert.equal(third.status, 200);
  assert.equal(mocks.stats.kcLogin - s0.kcLogin, 2);

  env.variables.KC_PASSWORD = 'wrong';
  await writeFile(envFile, YAML.stringify(env));
  await writeFile(e.localFile, ''); // no token left
  const bad = await runRequest(p.reqFile, { project, env: await loadEnv(project, 'mock'), flow: {}, runtime: {}, saveToken: false });
  assert.match(bad.error, /Invalid user credentials/);
});

test('leveldb: snappy blocks and log records decode (Postman desktop store reader)', async () => {
  const { unsnappy, logEntries } = await import('../lib/leveldb.mjs');
  // "aaaaaaaaaa": literal "a", then copy 9 bytes from 1 back (overlapping copy)
  assert.equal(unsnappy(Buffer.from([0x0a, 0x00, 0x61, 0x01 | ((9 - 4) << 2), 0x01])).toString(), 'aaaaaaaaaa');
  // a write-ahead log block with one batch: put("k1" → "v1"), delete("k2")
  const batch = Buffer.concat([
    Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]), // sequence 7
    Buffer.from([2, 0, 0, 0]), // 2 entries
    Buffer.from([1, 2]), Buffer.from('k1'), Buffer.from([2]), Buffer.from('v1'),
    Buffer.from([0, 2]), Buffer.from('k2'),
  ]);
  const header = Buffer.alloc(7);
  header.writeUInt16LE(batch.length, 4);
  header[6] = 1; // FULL record
  const entries = [...logEntries(Buffer.concat([header, batch]))];
  assert.deepEqual(entries.map((e) => [e.key.toString(), e.seq, e.deleted, e.value?.toString() ?? null]), [['k1', 7, false, 'v1'], ['k2', 8, true, null]]);
});

test('collections: type on create — REST gets {{BASE_URL}} and no schema discovery', async () => {
  const { createCollection } = await import('../lib/scaffold.mjs');
  const p = await makeProject();
  const rest = await createCollection(p.project, { name: 'Payments', type: 'rest' });
  const doc = YAML.parse(await readFile(path.join(p.dir, rest.dir, '_collection.yaml'), 'utf8'));
  assert.equal(doc.type, 'rest');
  assert.equal(doc.execution.url, '{{BASE_URL}}');
  assert.equal(doc.schemaDiscovery, undefined);
  const gql = await createCollection(p.project, { name: 'Lab' });
  assert.equal(YAML.parse(await readFile(path.join(p.dir, gql.dir, '_collection.yaml'), 'utf8')).type, 'graphql');
});

test('realtime: WebSocket (headers), Socket.IO (namespace auth, events, acks), gRPC (unary + metadata, server streaming)', async () => {
  const { startRealtimeMocks } = await import('../lib/mock-realtime.mjs');
  const { openWebSocket, openSocketIO, closeSession } = await import('../lib/realtime.mjs');
  const { describeProto, callGrpc } = await import('../lib/grpc.mjs');
  const rt = await startRealtimeMocks();
  const until = async (s, pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(s.log)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${JSON.stringify(s.log)}`);
  };
  try {
    // WebSocket with a header
    const ws = openWebSocket({ url: `${rt.wsUrl}/secure`, headers: { Authorization: 'Bearer good' } });
    await until(ws, (l) => l.some((e) => e.state === 'open'));
    ws.send('hi');
    await until(ws, (l) => l.some((e) => e.data === 'secure echo: hi'));
    assert.ok(ws.log.some((e) => e.dir === 'in' && e.data === 'welcome'));
    closeSession(ws.id);

    // Socket.IO: wrong token is refused, right token connects; events echo; acks come back
    const bad = openSocketIO({ url: rt.httpUrl, namespace: '/admin', auth: { token: 'nope' } });
    await until(bad, (l) => l.some((e) => e.error && /unauthorized/.test(e.data)));
    closeSession(bad.id);
    const io = openSocketIO({ url: rt.httpUrl, namespace: '/admin', auth: { token: 'good' } });
    await until(io, (l) => l.some((e) => e.state === 'open'));
    io.emit('chat', [{ text: 'hello' }]);
    await until(io, (l) => l.some((e) => e.event === 'chat:echo' && e.data.text === 'hello'));
    io.emit('save', [1], true);
    await until(io, (l) => l.some((e) => e.event === 'ack: save' && e.data.ok === true));
    closeSession(io.id);

    // gRPC
    const services = await describeProto(rt.protoFile);
    assert.deepEqual(services.map((s) => s.name), ['demo.Echo']);
    const say = services[0].methods.find((m) => m.name === 'Say');
    assert.deepEqual(say.example, { text: '', n: 0, who: { name: '' } });
    const denied = await callGrpc({ file: rt.protoFile, address: rt.grpcAddress, service: 'demo.Echo', method: 'Say', message: { text: 'x' } });
    assert.equal(denied.status, 'UNAUTHENTICATED');
    const ok = await callGrpc({ file: rt.protoFile, address: rt.grpcAddress, service: 'demo.Echo', method: 'Say', message: { who: { name: 'Ann' }, n: 1 }, headers: { Authorization: 'Bearer good' } });
    assert.equal(ok.status, 'OK');
    assert.deepEqual(ok.response, { text: 'hello Ann', n: 2, who: null });
    const stream = await callGrpc({ file: rt.protoFile, address: rt.grpcAddress, service: 'demo.Echo', method: 'Count', message: { upTo: 3 } });
    await until(stream.session, (l) => l.some((e) => e.state === 'closed'));
    assert.deepEqual(stream.session.log.filter((e) => e.dir === 'in').map((e) => e.data.text), ['#1', '#2', '#3']);
  } finally {
    await rt.close();
  }
});

test('realtime in the app: WebSocket / Socket.IO requests (env URL + collection Bearer), gRPC describe, unary and stream', async () => {
  const { startRealtimeMocks } = await import('../lib/mock-realtime.mjs');
  const { serve } = await import('../lib/server.mjs');
  const rt = await startRealtimeMocks();
  const mocks2 = await startMocks({ tokenTtlSec: 300 });
  const root = await mkdtemp(path.join(tmpdir(), 'hyperion-rt-app-'));
  await writeSample(root, { ...mocks2, realtime: rt });
  const server = await serve({ dir: root, port: 0, registry: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  // follow a session's events until `until` is true
  const follow = async (id, until) => {
    const res = await fetch(`${base}/api/rt/events?id=${id}`);
    const reader = res.body.getReader();
    const seen = [];
    let buf = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !until(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const chunk of buf.split('\n\n').slice(0, -1)) seen.push(JSON.parse(chunk.replace(/^data: /, '')));
      buf = buf.split('\n\n').at(-1);
    }
    reader.cancel();
    return seen;
  };
  try {
    const tree = await call('/api/tree');
    assert.deepEqual(tree.requests.filter((r) => r.kind !== 'GraphQLRequest').map((r) => r.op).sort(), ['SIO', 'WS', 'gRPC', 'gRPC']);

    // WebSocket: URL from the env, Authorization from the collection's Bearer {{RT_TOKEN}}
    const ws = await call('/api/rt/start', { file: 'collections/websocket/ws-echo.req.yaml', env: 'dev' });
    await follow(ws.id, (s) => s.some((e) => e.state === 'open'));
    await call('/api/rt/send', { id: ws.id, file: 'collections/websocket/ws-echo.req.yaml', env: 'dev', message: 'hn={{TARGET_HN}}' });
    const wsLog = await follow(ws.id, (s) => s.some((e) => e.dir === 'in' && /secure echo/.test(e.data)));
    assert.ok(wsLog.some((e) => e.dir === 'in' && e.data === 'welcome'));
    assert.ok(wsLog.some((e) => e.data === 'secure echo: hn=123456'));
    await call('/api/rt/close', { id: ws.id });

    // Socket.IO: namespace /admin gets { token } from the Bearer header; emit with ack
    const sio = await call('/api/rt/start', { file: 'collections/websocket/socketio-admin.req.yaml', env: 'dev' });
    await follow(sio.id, (s) => s.some((e) => e.state === 'open'));
    await call('/api/rt/send', { id: sio.id, file: 'collections/websocket/socketio-admin.req.yaml', env: 'dev', event: 'ward:subscribe', message: '{"ward":"{{UNIT_CODE}}"}', ack: true });
    await call('/api/rt/send', { id: sio.id, file: 'collections/websocket/socketio-admin.req.yaml', env: 'dev', event: 'chat', message: '"hi"' });
    const sioLog = await follow(sio.id, (s) => s.some((e) => e.event === 'chat:echo'));
    assert.ok(sioLog.some((e) => e.event === 'ack: ward:subscribe' && e.data.ok === true));
    assert.ok(sioLog.some((e) => e.dir === 'out' && e.data.ward === 'OPD'));
    await call('/api/rt/close', { id: sio.id });

    // gRPC: describe the proto, unary with metadata from the collection auth, server stream as a session
    const d = await call('/api/grpc/describe?file=collections/grpc/grpc-say.req.yaml&env=dev');
    assert.deepEqual(d.services[0].methods.map((m) => m.name), ['Say', 'Count']);
    const unary = await call('/api/rt/start', { file: 'collections/grpc/grpc-say.req.yaml', env: 'dev' });
    assert.equal(unary.result.status, 'OK');
    assert.equal(unary.result.response.text, 'hello svc-hyperion');
    const stream = await call('/api/rt/start', { file: 'collections/grpc/grpc-count.req.yaml', env: 'dev', rt: { message: '{"upTo": 3}' } });
    const sLog = await follow(stream.id, (s) => s.some((e) => e.state === 'closed'));
    assert.deepEqual(sLog.filter((e) => e.dir === 'in').map((e) => e.data.text), ['#1', '#2', '#3']);

    // REST host → env variable (short and long name of one machine), rename keeps the file
    const rest = await call('/api/collection', { name: 'Legacy', type: 'rest' });
    const r1 = (await call('/api/request/new', { collection: rest.dir, name: 'A', kind: 'HttpRequest', url: 'http://d-node:8080/svc/a' })).file;
    const r2 = (await call('/api/request/new', { collection: rest.dir, name: 'B', kind: 'HttpRequest', url: 'http://d-node.example.org:8080/svc/b?x=1' })).file;
    const r3 = (await call('/api/request/new', { collection: rest.dir, name: 'C', kind: 'HttpRequest', url: 'http://other:9000/c' })).file;
    assert.equal((await call('/api/request?file=' + r1 + '&env=dev')).fixedHost, 'http://d-node:8080');
    assert.deepEqual((await call('/api/hosts')).hosts.map((h) => h.origin).sort(), ['http://d-node.example.org:8080', 'http://d-node:8080', 'http://other:9000']);
    const conv = await call('/api/host/to-var', { name: 'NODE', env: 'dev', value: 'http://d-node:8080', hosts: ['http://d-node:8080', 'http://d-node.example.org:8080'], values: { prod: 'http://prod-node:8080/', test: '' } });
    assert.equal(conv.changed, 2);
    const reqB = YAML.parse(await readFile(path.join(root, r2), 'utf8'));
    assert.equal(reqB.url, '{{NODE}}/svc/b?x=1');
    assert.equal(YAML.parse(await readFile(path.join(root, r3), 'utf8')).url, 'http://other:9000/c');
    assert.equal(YAML.parse(await readFile(path.join(root, 'envs/prod.env.yaml'), 'utf8')).variables.NODE, 'http://prod-node:8080');
    assert.equal(YAML.parse(await readFile(path.join(root, 'envs/test.env.yaml'), 'utf8')).variables.NODE, undefined);
    const opened = await call('/api/request?file=' + r1 + '&env=dev');
    // prod's host comes along so the app can show it while dev is picked
    assert.deepEqual([opened.fixedHost, opened.hostVar], [null, { name: 'NODE', value: 'http://d-node:8080', prod: { env: 'Prod (mock)', value: 'http://prod-node:8080' } }]);
    await call('/api/save', { file: r1, name: 'Get A (renamed)' });
    assert.ok((await call('/api/tree')).requests.some((r) => r.file === r1 && r.name === 'Get A (renamed)'));

    // saving settings with the auth unchanged, on a collection with no per-env auth yet (used to fail with a YAML error)
    const sampleAuth = (await call('/api/collection/settings?dir=collections/sample&env=dev')).auth;
    assert.equal((await call('/api/collection/settings', { dir: 'collections/sample', env: 'dev', auth: sampleAuth })).saved, true);

    // collection variables: edited in settings, a key / password value goes to secrets.local.yaml
    await call('/api/collection/settings', { dir: rest.dir, variables: { baseUrl: 'http://gw/x', apiKey: 'k-123', hn: '42' } });
    const colDoc = YAML.parse(await readFile(path.join(root, rest.dir, '_collection.yaml'), 'utf8'));
    assert.deepEqual(colDoc.variables, { baseUrl: 'http://gw/x', apiKey: '{{secret:LEGACY_APIKEY}}', hn: '42' });
    assert.equal(YAML.parse(await readFile(path.join(root, 'secrets.local.yaml'), 'utf8')).LEGACY_APIKEY, 'k-123');
    assert.deepEqual((await call('/api/collection/settings?dir=' + rest.dir + '&env=dev')).variables, colDoc.variables);
    const { loadProject } = await import('../lib/project.mjs');
    const p2 = await loadProject(root);
    const vv = createVars({ collection: colDoc.variables, env: await loadEnv(p2, 'dev'), secrets: p2.secrets });
    assert.equal(interpolate('{{baseUrl}}?k={{apiKey}}', vv), 'http://gw/x?k=k-123');

    // Scripts tab: the edited test runs on Send (not yet saved), then autosave writes it to the file
    const gp = 'collections/sample/patient/get-patient.req.yaml';
    const scripts = { beforeRequest: '', afterResponse: '$test("from the app", () => {\n  $expect($res.status).toBe(200);\n});\n' };
    const ran = await call('/api/run', { file: gp, env: 'dev', scripts });
    assert.deepEqual(ran.tests.map((x) => [x.name, x.pass]), [['from the app', true]]);
    await call('/api/save', { file: gp, scripts });
    const gpDoc = YAML.parse(await readFile(path.join(root, gp), 'utf8'));
    assert.equal(gpDoc.scripts.beforeRequest, undefined);
    assert.match(gpDoc.scripts.afterResponse, /from the app/);

    // delete: the file goes to .hyperion/trash and leaves the tree
    const del = await call('/api/request/delete', { file: 'collections/grpc/grpc-count.req.yaml' });
    assert.match(del.trash, /^\.hyperion\/trash\/.+grpc-count\.req\.yaml$/);
    assert.ok(!(await call('/api/tree')).requests.some((r) => r.file === 'collections/grpc/grpc-count.req.yaml'));
    await assert.rejects(call('/api/request/delete', { file: 'hyperion.yaml' }));

    // saving realtime fields keeps them at the top level of the request file
    await call('/api/save', { file: 'collections/websocket/socketio-admin.req.yaml', rt: { event: 'ward:leave', ack: false } });
    const saved = YAML.parse(await readFile(path.join(root, 'collections/websocket/socketio-admin.req.yaml'), 'utf8'));
    assert.equal(saved.event, 'ward:leave');
    assert.equal(saved.ack, undefined);
  } finally {
    server.close();
    await rt.close();
    await mocks2.close?.();
  }
});

test('SOAP: WSDL describe (imported XSD), import into a soap collection, run 1.1 / 1.2 with $res.xml, faults', async () => {
  const { startSoapMock } = await import('../lib/mock-soap.mjs');
  const { describeWsdl } = await import('../lib/wsdl.mjs');
  const { serve } = await import('../lib/server.mjs');
  const soap = await startSoapMock();
  const mocks2 = await startMocks({ tokenTtlSec: 300 });
  const root = await mkdtemp(path.join(tmpdir(), 'hyperion-soap-'));
  await writeSample(root, { ...mocks2, soap });
  const server = await serve({ dir: root, port: 0, registry: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, body) => {
    const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    return j;
  };
  try {
    // describe: two ports (1.1 + 1.2), actions, envelopes built from the XSD (nested types, imported enum, choice, optional)
    const d = await describeWsdl(soap.wsdlUrl);
    assert.deepEqual(d.notes, []);
    const ports = d.services[0].ports;
    assert.deepEqual(ports.map((p) => [p.name, p.soapVersion, p.address]), [['HospitalSoap', '1.1', soap.url], ['HospitalSoap12', '1.2', soap.url]]);
    assert.deepEqual(ports[0].operations.map((o) => [o.name, o.action]), [['GetPatient', 'http://example.org/hospital/GetPatient'], ['BookAppointment', 'http://example.org/hospital/BookAppointment']]);
    const [getEnv, bookEnv] = ports[0].operations.map((o) => o.envelope);
    assert.match(getEnv, /<soap:Envelope xmlns:soap="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/" xmlns:tns="http:\/\/example\.org\/hospital">/);
    assert.match(getEnv, /<tns:GetPatient>\s*<tns:hn>\?<\/tns:hn>\s*<\/tns:GetPatient>/);
    assert.match(bookEnv, /<tns:slot>\s*<tns:date>\d{4}-\d\d-\d\d<\/tns:date>\s*<tns:department>OPD<\/tns:department>\s*<tns:durationMin>0<\/tns:durationMin>/);
    assert.match(bookEnv, /<!-- optional -->\s*<tns:phone>/);
    assert.match(bookEnv, /<!-- choice: one of walkIn, referralNo -->\s*<tns:walkIn>false<\/tns:walkIn>/);
    assert.match(ports[1].operations[0].envelope, /xmlns:soap="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);

    // the sample's SOAP requests: tree op, GET /api/request soap fields + inherited URL
    const tree = await call('/api/tree');
    assert.deepEqual(tree.requests.filter((r) => r.kind === 'SoapRequest').map((r) => r.op), ['SOAP', 'SOAP']);
    const gp = 'collections/soap/get-patient.req.yaml';
    const opened = await call(`/api/request?file=${gp}&env=dev`);
    assert.equal(opened.url, '{{SOAP_URL}}');
    assert.equal(opened.resolvedUrl, soap.url);
    assert.deepEqual(Object.keys(opened.soap).sort(), ['action', 'envelope', 'operation', 'soapVersion', 'wsdl']);
    assert.equal(opened.soap.soapVersion, '1.1');
    const viaApi = await call(`/api/soap/wsdl?file=${gp}&env=dev`); // the request's wsdl: {{SOAP_URL}}?wsdl
    assert.equal(viaApi.services[0].ports[0].operations.length, 2);

    // run 1.1: SOAPAction + text/xml, $res.xml assertions in the sample's afterResponse script
    const ok = await call('/api/run', { file: gp, env: 'dev' });
    assert.equal(ok.status, 200, ok.error);
    assert.equal(ok.response.headers['x-soap-version'], '1.1');
    assert.equal(ok.response.headers['x-soap-action'], 'http://example.org/hospital/GetPatient');
    assert.equal(ok.response.headers['x-soapaction-header'], '"http://example.org/hospital/GetPatient"');
    assert.deepEqual(ok.tests.map((t) => [t.name, t.pass]), [['no SOAP Fault', true], ['patient returned', true]]);
    assert.equal(ok.soapFault, undefined);
    assert.equal(ok.passed, true);

    // unsaved edits (body.soap) win: an unknown HN → SOAP Fault, warning, xmlAll
    const edited = opened.soap.envelope.replace('{{TARGET_HN}}', '999');
    const afterResponse = '$test("fault", () => { $expect($res.xml("faultstring")).toBe("Patient 999 not found"); $expect($res.xmlAll("Body")).toHaveLength(1); });';
    const fault = await call('/api/run', { file: gp, env: 'dev', soap: { envelope: edited }, scripts: { afterResponse } });
    assert.equal(fault.status, 500);
    assert.deepEqual(fault.soapFault, { code: 'soap:Client', string: 'Patient 999 not found' });
    assert.ok(fault.warnings.includes('SOAP Fault: soap:Client — Patient 999 not found'));
    assert.equal(fault.tests[0].pass, true, fault.tests[0].error);

    // SOAP 1.2: application/soap+xml; action="…", no SOAPAction header; a 1.2 fault
    const book = await call('/api/run', { file: 'collections/soap/book-appointment.req.yaml', env: 'dev' });
    assert.equal(book.status, 200, book.error);
    assert.equal(book.response.headers['x-soap-version'], '1.2');
    assert.equal(book.response.headers['x-soap-action'], 'http://example.org/hospital/BookAppointment');
    assert.equal(book.response.headers['x-soapaction-header'], '(none)');
    assert.equal(book.tests[0].pass, true);
    const f12 = await call('/api/run', { file: 'collections/soap/book-appointment.req.yaml', env: 'dev', soap: { envelope: ports[1].operations[1].envelope } });
    assert.deepEqual(f12.soapFault, { code: 'soap:Sender', string: 'Patient ? not found' });
    assert.equal(f12.passed, false);

    // save: top-level fields, '' removes one, envelope as a literal block
    await call('/api/save', { file: gp, soap: { soapVersion: '1.2', operation: '', envelope: '<x/>' } });
    const savedText = await readFile(path.join(root, gp), 'utf8');
    const saved = YAML.parse(savedText);
    assert.equal(saved.soapVersion, '1.2');
    assert.equal(saved.operation, undefined);
    assert.equal(saved.envelope, '<x/>\n');
    assert.match(savedText, /envelope: \|/);

    // import into a new soap collection: one request per operation of the 1.1 port, SOAP_URL set for the env
    const col = await call('/api/collection', { name: 'Imported SOAP', type: 'soap' });
    const colDoc = YAML.parse(await readFile(path.join(root, col.dir, '_collection.yaml'), 'utf8'));
    assert.deepEqual([colDoc.type, colDoc.execution.url, colDoc.schemaDiscovery], ['soap', '{{SOAP_URL}}', undefined]);
    const envFile = path.join(root, 'envs/test.env.yaml');
    const envDoc = YAML.parse(await readFile(envFile, 'utf8'));
    delete envDoc.variables.SOAP_URL;
    await writeFile(envFile, YAML.stringify(envDoc));
    const imp = await call('/api/soap/import', { collection: col.dir, wsdl: soap.wsdlUrl, env: 'test' });
    assert.equal(imp.count, 2);
    assert.equal(imp.service, 'HospitalService');
    assert.equal(imp.address, soap.url);
    assert.equal(YAML.parse(await readFile(envFile, 'utf8')).variables.SOAP_URL, soap.url);
    const r0 = YAML.parse(await readFile(path.join(root, imp.files[0]), 'utf8'));
    assert.deepEqual(
      [r0.kind, r0.metadata.name, r0.soapVersion, r0.action, r0.operation, r0.wsdl, r0.url],
      ['SoapRequest', 'GetPatient', '1.1', 'http://example.org/hospital/GetPatient', 'GetPatient', soap.wsdlUrl, undefined],
    );
    // an imported request runs with the collection URL
    const ran = await call('/api/run', { file: imp.files[0], env: 'test', soap: { envelope: r0.envelope.replace('>?<', '>42<') }, scripts: { afterResponse: '$test("name", () => $expect($res.xml("lastName")).toBe("Dent"));' } });
    assert.equal(ran.status, 200, ran.error);
    assert.equal(ran.tests[0].pass, true);

    // starter request in a soap collection
    const starter = (await call('/api/request/new', { collection: col.dir, name: 'Blank', kind: 'SoapRequest' })).file;
    const sd = YAML.parse(await readFile(path.join(root, starter), 'utf8'));
    assert.deepEqual([sd.soapVersion, sd.action], ['1.1', '']);
    assert.match(sd.envelope, /<soap:Body>/);
    assert.equal((await call('/api/collection/settings', { dir: col.dir, type: 'soap' })).saved, true);
  } finally {
    server.close();
    await soap.close();
    await mocks2.close?.();
  }
});

test('export / import: a flow with its requests as one *.hyperion.json; no secrets; changed requests saved alongside', async () => {
  const { exportBundle, importBundle } = await import('../lib/bundle.mjs');
  const { createFlow } = await import('../lib/flow.mjs');
  const mk = async (name) => {
    const d = await mkdtemp(path.join(tmpdir(), `hyperion-bundle-${name}-`));
    await writeSample(d, { prodUrl: 'http://prod.example', devUrl: 'http://dev.example' });
    return loadProject(d);
  };
  const a = await mk('a');
  const flowFile = await createFlow(a, 'Patient check');
  const steps = [{ request: 'collections/sample/patient/get-patient.req.yaml' }, { request: 'collections/sample/pharmacy/create-prescription.req.yaml' }];
  await writeFile(path.join(a.root, flowFile), YAML.stringify({ apiVersion: 'hyperion/v3', kind: 'Flow', metadata: { name: 'Patient check' }, steps }));
  const bundle = await exportBundle(a, [flowFile]);
  const paths = bundle.items.map((i) => i.path);
  assert.ok(paths.includes(flowFile) && paths.includes(steps[0].request) && paths.includes(steps[1].request));
  assert.ok(paths.includes('collections/sample/_collection.yaml'));
  assert.ok(!paths.some((p) => /secrets|\.local\./.test(p)));
  assert.ok(!JSON.stringify(bundle).includes('dev-key')); // the sample's secret value

  // a fresh project gets everything
  const bDir = await mkdtemp(path.join(tmpdir(), 'hyperion-bundle-b-'));
  await writeFile(path.join(bDir, 'hyperion.yaml'), 'apiVersion: hyperion/v3\nkind: Project\nname: B\n');
  const b = await loadProject(bDir);
  const r1 = await importBundle(b, bundle);
  assert.deepEqual(r1.collections, ['collections/sample']);
  assert.equal(r1.requests.created.length, 2);
  assert.deepEqual(r1.flows, [flowFile]);

  // a project with a changed copy keeps it; the imported one goes alongside and the flow points at it
  const c = await mk('c');
  await writeFile(path.join(c.root, steps[0].request), 'apiVersion: hyperion/v3\nkind: GraphQLRequest\nmetadata: { name: Mine }\npayload: { query: "{ x }" }\n');
  const r2 = await importBundle(c, bundle);
  assert.equal(r2.requests.renamed[0].to, 'collections/sample/patient/get-patient-imported.req.yaml');
  assert.equal(r2.requests.same.length, 1);
  const flow = YAML.parse(await readFile(path.join(c.root, r2.flows[0]), 'utf8'));
  assert.equal(flow.steps[0].request, 'collections/sample/patient/get-patient-imported.req.yaml');
  await assert.rejects(importBundle(c, { kind: 'HyperionExport', items: [{ path: '../evil.req.yaml', content: 'x' }] }));
});
