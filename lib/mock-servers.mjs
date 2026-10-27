// Mock API for tests and the demo: a target with introspection off and JWT auth, plus a dev server that allows introspection with an API key.
import http from 'node:http';
import { buildSchema, graphql } from 'graphql';

const SDL_PROD = `
  scalar Date
  type Visit { visitId: ID!, department: String }
  type Patient { hn: String!, firstName: String, lastName: String, visits(date: Date): [Visit!]! }
  type Prescription { id: ID!, visitId: ID! }
  type Query { patient(hn: String!): Patient }
  type Mutation { createPrescription(visitId: ID!, drug: String!): Prescription }
`;
// Dev is one sprint ahead: has Patient.allergyList that Prod does not have yet.
const SDL_DEV = SDL_PROD.replace(
  'visits(date: Date): [Visit!]! }',
  'visits(date: Date): [Visit!]!, allergyList: [Allergy!]! }\n  type Allergy { drugName: String, severity: String }',
);

const root = {
  patient: ({ hn }) =>
    hn === '404'
      ? null
      : { hn, firstName: 'ทดสอบ', lastName: 'ระบบ', visits: [{ visitId: 'V-1', department: 'MED' }], allergyList: [] },
  createPrescription: ({ visitId }) => ({ id: 'RX-1', visitId }),
};

const jwt = (expSec) =>
  [{ alg: 'none' }, { sub: 'svc', exp: Math.floor(Date.now() / 1000) + expSec }]
    .map((p) => Buffer.from(JSON.stringify(p)).toString('base64url'))
    .join('.') + '.sig';

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    // JSON, or a form (OAuth2 token endpoints)
    req.on('end', () => {
      if (!b) return resolve({});
      try {
        resolve(JSON.parse(b));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(b)));
      }
    });
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startMocks({ tokenTtlSec = 3600, prodPort = 0, devPort = 0 } = {}) {
  const stats = { login: 0, refresh: 0, prodCalls: 0, devIntrospections: 0, revoked: new Set(), kcLogin: 0, kcRefresh: 0, kcForm: 0 };
  const valid = new Set();
  const prodSchema = buildSchema(SDL_PROD);
  const devSchema = buildSchema(SDL_DEV);

  const prod = http.createServer(async (req, res) => {
    const body = await readBody(req);
    // Keycloak-style OpenID token endpoint: form body, grant_type password / refresh_token, snake_case reply
    if (req.url === '/realms/demo/protocol/openid-connect/token') {
      if (String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) stats.kcForm++;
      if (body.client_id !== 'hyperion') return json(res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials' });
      if (body.grant_type === 'password') {
        stats.kcLogin++;
        if (body.username !== 'svc-hyperion' || body.password !== 'pw') return json(res, 401, { error: 'invalid_grant', error_description: 'Invalid user credentials' });
      } else if (body.grant_type === 'refresh_token') {
        stats.kcRefresh++;
        if (!valid.has(`r:${body.refresh_token}`) || stats.revoked.has(`r:${body.refresh_token}`)) return json(res, 400, { error: 'invalid_grant', error_description: 'Token is not active' });
      } else return json(res, 400, { error: 'unsupported_grant_type' });
      const accessToken = jwt(tokenTtlSec) + Math.random().toString(36).slice(2, 6);
      const refreshToken = `rt-${Math.random().toString(36).slice(2)}`;
      valid.add(accessToken);
      valid.add(`r:${refreshToken}`);
      return json(res, 200, { access_token: accessToken, expires_in: tokenTtlSec, refresh_expires_in: 1800, refresh_token: refreshToken, token_type: 'Bearer' });
    }
    if (req.url === '/api/auth/token') {
      stats.login++;
      if (body.username !== 'svc-hyperion' || body.password !== 'pw') return json(res, 401, { error: 'bad credentials' });
    } else if (req.url === '/api/auth/token/refresh') {
      stats.refresh++;
      if (!valid.has(`r:${body.refreshToken}`)) return json(res, 401, { error: 'bad refresh token' });
    }
    if (req.url.startsWith('/api/auth/token')) {
      const accessToken = jwt(tokenTtlSec) + Math.random().toString(36).slice(2, 6);
      const refreshToken = `rt-${Math.random().toString(36).slice(2)}`;
      valid.add(accessToken);
      valid.add(`r:${refreshToken}`);
      return json(res, 200, { accessToken, refreshToken });
    }
    if (req.url === '/graphql') {
      stats.prodCalls++;
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!valid.has(token) || stats.revoked.has(token)) return json(res, 401, { errors: [{ message: 'Unauthorized' }] });
      if (/__schema/.test(body.query)) return json(res, 200, { errors: [{ message: 'GraphQL introspection is not allowed' }] });
      return json(res, 200, await graphql({ schema: prodSchema, source: body.query, rootValue: root, variableValues: body.variables }));
    }
    json(res, 404, {});
  });

  const dev = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.headers['x-dev-introspection-key'] !== 'dev-key' && !valid.has(bearer)) return json(res, 403, { errors: [{ message: 'forbidden' }] });
    stats.devIntrospections++;
    json(res, 200, await graphql({ schema: devSchema, source: body.query, rootValue: root, variableValues: body.variables }));
  });

  await Promise.all([[prod, prodPort], [dev, devPort]].map(([s, p]) => new Promise((r) => s.listen(p, '127.0.0.1', r))));
  return {
    prodUrl: `http://127.0.0.1:${prod.address().port}`,
    devUrl: `http://127.0.0.1:${dev.address().port}`,
    stats,
    revokeAll: () => valid.forEach((t) => stats.revoked.add(t)),
    close: () => Promise.all([prod, dev].map((s) => new Promise((r) => s.close(r)))),
  };
}
