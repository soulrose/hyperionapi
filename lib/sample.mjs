// A ready-to-run sample project against lib/mock-servers.mjs — used by `hyperion demo` and the tests.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { ENVS } from './init.mjs';
import { ECHO_PROTO } from './mock-realtime.mjs';

const y = (o) => YAML.stringify(o, { blockQuote: 'literal', lineWidth: 0 });

export async function writeSample(dir, { prodUrl, devUrl, realtime }) {
  const files = {
    // WebSocket / Socket.IO / gRPC against lib/mock-realtime.mjs (only when those mocks run)
    ...(realtime && {
      'collections/websocket/_collection.yaml': {
        apiVersion: 'hyperion/v3',
        kind: 'Collection',
        type: 'websocket',
        metadata: { name: 'Live (WebSocket)' },
        execution: { url: '{{WS_URL}}', auth: { type: 'bearer', bearer: { token: '{{RT_TOKEN}}' } } },
      },
      'collections/grpc/_collection.yaml': {
        apiVersion: 'hyperion/v3',
        kind: 'Collection',
        type: 'grpc',
        metadata: { name: 'Echo (gRPC)' },
        execution: { url: '{{GRPC_ADDRESS}}', auth: { type: 'bearer', bearer: { token: '{{RT_TOKEN}}' } } },
      },
      'collections/websocket/ws-echo.req.yaml': { apiVersion: 'hyperion/v3', kind: 'WebSocketRequest', metadata: { name: 'WebSocket echo' }, url: '{{WS_URL}}/secure', message: '{\n  "hn": "{{TARGET_HN}}"\n}\n' },
      'collections/websocket/socketio-admin.req.yaml': {
        apiVersion: 'hyperion/v3',
        kind: 'SocketIORequest',
        metadata: { name: 'Socket.IO /admin' },
        url: '{{SIO_URL}}',
        namespace: '/admin',
        event: 'ward:subscribe',
        ack: true,
        message: '{\n  "ward": "{{UNIT_CODE}}"\n}\n',
      },
      'collections/grpc/grpc-say.req.yaml': {
        apiVersion: 'hyperion/v3',
        kind: 'GrpcRequest',
        metadata: { name: 'gRPC Echo.Say' },
        url: '{{GRPC_ADDRESS}}',
        proto: 'protos/echo.proto',
        service: 'demo.Echo',
        method: 'Say',
        message: '{\n  "text": "hi",\n  "n": 1,\n  "who": { "name": "{{APP_USER}}" }\n}\n',
      },
      'collections/grpc/grpc-count.req.yaml': {
        apiVersion: 'hyperion/v3',
        kind: 'GrpcRequest',
        metadata: { name: 'gRPC Echo.Count (stream)' },
        url: '{{GRPC_ADDRESS}}',
        proto: 'protos/echo.proto',
        service: 'demo.Echo',
        method: 'Count',
        message: '{\n  "upTo": 5\n}\n',
      },
    }),
    'hyperion.yaml': { apiVersion: 'hyperion/v3', kind: 'Project', name: 'Demo (mock API)', defaultEnv: 'dev' },
    'secrets.local.yaml': { DEMO_PASSWORD: 'pw', DEV_INTROSPECTION_KEY: 'dev-key' },
    'collections/sample/_collection.yaml': {
      apiVersion: 'hyperion/v3',
      kind: 'Collection',
      metadata: { name: 'Sample API' },
      masking: { fields: ['fullName', 'firstName', 'lastName', 'idCard', 'citizenId', 'phone', 'address'] },
      execution: {
        url: '{{GQL_URL}}',
        timeoutMs: 15000,
        auth: {
          type: 'tokenEndpoint',
          tokenEndpoint: {
            url: '{{AUTH_URL}}',
            body: { username: '{{APP_USER}}', password: '{{APP_PASSWORD}}' },
            tokenPath: 'accessToken',
            refresh: { url: '{{AUTH_URL}}/refresh', body: { refreshToken: '{{REFRESH_TOKEN}}' } },
            skewSeconds: 60,
          },
        },
        headers: { 'X-Unit': '{{UNIT_CODE}}' },
      },
      schemaDiscovery: {
        mode: 'AUTO_FALLBACK',
        probeTarget: true,
        fallbackUrl: '{{SCHEMA_URL}}',
        offlineSnapshot: '../../schemas/sample.snapshot.graphql',
        cacheTtlMinutes: 1440,
        auth: { type: 'apiKey', apiKey: { in: 'header', name: 'X-Dev-Introspection-Key', value: '{{secret:DEV_INTROSPECTION_KEY}}' } },
      },
    },
    'collections/sample/patient/get-patient.req.yaml': {
      apiVersion: 'hyperion/v3',
      kind: 'GraphQLRequest',
      metadata: { name: 'Get Patient' },
      payload: {
        operationName: 'GetPatient',
        query: 'query GetPatient($hn: String!, $visitDate: Date!) {\n  patient(hn: $hn) {\n    hn\n    firstName\n    lastName\n    visits(date: $visitDate) {\n      visitId\n      department\n    }\n  }\n}\n',
        variables: { hn: '{{TARGET_HN}}', visitDate: '{{$today}}' },
      },
      scripts: {
        beforeRequest: '$req.headers.set("X-Request-Timestamp", Date.now().toString());\n',
        afterResponse:
          '$test("HTTP 200 and no GraphQL errors", () => {\n  $expect($res.status).toBe(200);\n  $expect($res.json.errors).toBeUndefined();\n});\n' +
          '$test("patient returned", () => {\n  const patient = $res.json.data?.patient;\n  $expect(patient).toBeTruthy();\n  $expect(patient.hn).toBe($req.variables.get("hn"));\n});\n' +
          'const latest = $res.json.data?.patient?.visits?.[0];\nif (latest) $flow.set("LATEST_VISIT_ID", latest.visitId);\n',
      },
    },
    'collections/sample/patient/patient-allergies.req.yaml': {
      apiVersion: 'hyperion/v3',
      kind: 'GraphQLRequest',
      metadata: { name: 'Patient Allergies (dev schema only)' },
      payload: {
        operationName: 'PatientAllergies',
        query: 'query PatientAllergies($hn: String!) {\n  patient(hn: $hn) {\n    hn\n    allergyList {\n      drugName\n      severity\n    }\n  }\n}\n',
        variables: { hn: '{{TARGET_HN}}' },
      },
    },
    'collections/sample/pharmacy/create-prescription.req.yaml': {
      apiVersion: 'hyperion/v3',
      kind: 'GraphQLRequest',
      metadata: { name: 'Create Prescription' },
      payload: {
        operationName: 'CreatePrescription',
        query: 'mutation CreatePrescription($visitId: ID!, $drug: String!) {\n  createPrescription(visitId: $visitId, drug: $drug) {\n    id\n    visitId\n  }\n}\n',
        variables: { visitId: '{{LATEST_VISIT_ID}}', drug: 'Paracetamol 500mg' },
      },
      scripts: {
        afterResponse: 'pm.test("prescription created", () => {\n  pm.response.to.have.status(200);\n  pm.expect(pm.response.json().data.createPrescription.id).to.be.a("string");\n});\n',
      },
    },
  };
  for (const e of ENVS) {
    files[`envs/${e}.env.yaml`] = {
      apiVersion: 'hyperion/v3',
      kind: 'Environment',
      metadata: { name: `${e[0].toUpperCase()}${e.slice(1)} (mock)` },
      protected: e === 'prod',
      variables: {
        GQL_URL: `${prodUrl}/graphql`,
        AUTH_URL: `${prodUrl}/api/auth/token`,
        SCHEMA_URL: `${devUrl}/graphql`,
        APP_USER: 'svc-hyperion',
        APP_PASSWORD: '{{secret:DEMO_PASSWORD}}',
        UNIT_CODE: 'OPD',
        TARGET_HN: '123456',
        ...(realtime && { WS_URL: realtime.wsUrl, SIO_URL: realtime.httpUrl, GRPC_ADDRESS: realtime.grpcAddress, RT_TOKEN: 'good' }),
      },
    };
  }
  for (const [rel, obj] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, y(obj), 'utf8');
  }
  if (realtime) {
    await mkdir(path.join(dir, 'protos'), { recursive: true });
    await writeFile(path.join(dir, 'protos', 'echo.proto'), ECHO_PROTO, 'utf8');
  }
  await writeFile(path.join(dir, '.gitignore'), '.hyperion/\n*.local.env.yaml\nsecrets.local.yaml\n');
}
