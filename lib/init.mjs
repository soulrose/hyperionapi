// `hyperion init` — scaffold a generic project (any GraphQL/REST API). Existing files are never overwritten.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './project.mjs';

export const ENVS = ['dev', 'test', 'prod', 'training'];

const env = (name) => `apiVersion: hyperion/v3
kind: Environment
metadata:
  name: ${name[0].toUpperCase()}${name.slice(1)}
protected: ${name === 'prod'}${name === 'prod' ? '            # mutations need confirmation; data-driven runs blocked' : ''}
variables:
  GQL_URL: https://<${name}-host>/graphql        # TODO
${name === 'dev' ? '' : `  # SCHEMA_URL: https://<host>/graphql         # optional — if ${name} hides its schema, the dev env's is used
`}  # AUTH_URL: https://<${name}-host>/api/auth/token
  # APP_USER: service-user
  # APP_PASSWORD: "{{secret:${name.toUpperCase()}_PASSWORD}}"
`;

const files = (name) => ({
  'hyperion.yaml': `apiVersion: hyperion/v3
kind: Project
name: ${name}
defaultEnv: dev
variables: {}
`,
  '.gitignore': `.hyperion/
*.local.env.yaml
secrets.local.yaml
`,
  'secrets.local.yaml.example': `# Copy to secrets.local.yaml (gitignored) or set env vars HYPERION_SECRET_<NAME> (CI).
${ENVS.map((e) => `${e.toUpperCase()}_PASSWORD: ""`).join('\n')}
`,
  ...Object.fromEntries(ENVS.map((e) => [`envs/${e}.env.yaml`, env(e)])),
  'collections/main/_collection.yaml': `apiVersion: hyperion/v3
kind: Collection
metadata:
  name: Main API

# fields hidden in responses until "show personal data" is ticked
masking:
  fields: [fullName, firstName, lastName, idCard, citizenId, phone, address]

# Where requests are really sent
execution:
  url: "{{GQL_URL}}"
  timeoutMs: 15000
  auth: none
  # Login + automatic refresh (token is written to envs/<env>.local.env.yaml):
  # auth:
  #   type: tokenEndpoint
  #   tokenEndpoint:
  #     url: "{{AUTH_URL}}"
  #     body: { username: "{{APP_USER}}", password: "{{APP_PASSWORD}}" }
  #     tokenPath: accessToken
  #     refresh:
  #       url: "{{AUTH_URL}}/refresh"
  #       body: { refreshToken: "{{REFRESH_TOKEN}}" }

# Where the schema for autocomplete comes from: try the target once; if it hides its schema,
# use SCHEMA_URL when an env sets it, otherwise the dev env's endpoint
schemaDiscovery:
  mode: AUTO_FALLBACK
  probeTarget: true
  fallbackUrl: "{{SCHEMA_URL}}"
  cacheTtlMinutes: 1440
`,
  'collections/main/example.req.yaml': `apiVersion: hyperion/v3
kind: GraphQLRequest
metadata:
  name: Example

payload:
  operationName: Example
  query: |
    query Example {
      __typename
    }
  variables: {}

scripts:
  afterResponse: |
    $test("HTTP 200 and no GraphQL errors", () => {
      $expect($res.status).toBe(200);
      $expect($res.json.errors).toBeUndefined();
    });
`,
});

export async function init(dir, { name } = {}) {
  const created = [];
  for (const [rel, content] of Object.entries(files(name?.trim() || path.basename(path.resolve(dir))))) {
    const full = path.join(dir, rel);
    if (await exists(full)) continue;
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    created.push(rel);
  }
  return created;
}
