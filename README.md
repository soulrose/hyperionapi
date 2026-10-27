# Hyperion API

**English** · [ไทย](README.th.md)

A light API client for every project: GraphQL, REST, SOAP, gRPC, WebSocket and Socket.IO. When an environment hides its GraphQL schema (introspection off), Hyperion borrows the schema from dev for autocomplete. It renews login tokens by itself, asks before a GraphQL mutation goes to prod, and imports from Postman.

- **Light:** plain Node.js, no build step, few dependencies (`yaml`, `graphql`, and `@grpc/*` for gRPC); the UI opens as its own window.
- **Git-native:** a project is a plain folder of YAML files. Keep it in the project's own repo and commit / review it; tokens and secrets live in gitignored files.

## Getting started

```bash
npm install
npm start               # opens Hyperion in its own window
npm run shortcut        # Windows: puts a "Hyperion API" icon on the Desktop
```

| Shortcut | What it does |
| :--- | :--- |
| **Hyperion API** icon on the Desktop | Create it once with `npm run shortcut` (or `node bin/hyperion.mjs shortcut`). Double-click opens Hyperion in its own window — no browser, no URL to type. |
| `start.bat` (OffLab → **Hyperion API**) | The same, with no console window; the server stops when the window is closed (log in `server.log`). The first time, it asks you to create or open a project. |
| `npm start` | The same from a terminal (`serve --open`); works on any OS. |
| `start-demo.bat` (OffLab → **demo**) | A demo against built-in mock APIs (prod with introspection off, dev, WebSocket, Socket.IO, gRPC). It starts fresh every time. |

- The window remembers its last size and position (maximised too) and reopens the same way. Stored in `%USERPROFILE%\.hyperion\window.json`. This works even when Edge keeps running in the background (Startup boost), which ignores `--window-size`: Hyperion places the window itself after it opens.
- Everything saves itself: the URL in the red bar, query, variables, Authorization, Headers, Scripts, flows, the env editor and collection settings — there is no Save button (Ctrl+S saves at once).
- Click the **Hyperion** logo (top left) for About: version and developer.

**Language:** the UI is English by default. Switch to Thai from the project menu → **Settings** → Language: ไทย (remembered on this computer). Thai text lives in `public/i18n.js` (UI) and `public/i18n-server.js` (server messages).

**Themes:** Settings → **Theme**: Modern (default) or Frutiger Aero (Vista) — glass panes on a sky background, glossy buttons. Applied at once and remembered. To add a theme, write `public/themes/<id>.css` (rules under `html[data-theme="<id>"]`) and add one line to the list in `public/themes.js`.

**Fonts:** the same **Settings** dialog sets the UI font, text size (90–125%), code font and code size. Only fonts installed on this computer are listed; changes apply at once and are remembered. Thai falls back to a Thai font when the chosen one has no Thai letters.

## Projects

- Click the project name next to the logo → pick a recent project, **Open folder…** (paste the path of a folder with `hyperion.yaml`) or **New project…**
- New projects are prefilled: name "My API" in a folder named after it under the projects folder (change the location with the `HYPERION_HOME` env var).
- A new project gets envs `dev`, `test`, `prod`, `training` (prod is protected) and a `Main API` collection with an example request — set `GQL_URL` in `envs/*.env.yaml` and send.
- The list of projects is kept in `%USERPROFILE%\.hyperion\projects.json`; no project files are stored inside the Hyperion folder.

## Schema when an env hides introspection

The schema loads by itself (when a request opens or the env changes and there is none yet or it is old, and after the URL changes); **Sync now** forces a reload. Sources are tried in order:

1. the current env itself (tried once; a refusal is remembered, so it is not retried every time)
2. `SCHEMA_URL`, if the env sets one
3. **the dev env's endpoint**, with dev's variables and login — nothing extra to set up

When a request opens (no network): if this env was never synced, it borrows the schema dev has cached, else the most recently synced env's. The Schema bar says which env it borrowed from. Pick a different source env with `schemaEnv: <env>` in `hyperion.yaml`.

## URL, auth and headers

- **The env's URL** (e.g. the dev host): type it into the URL box of the red "Send to" bar. If the request uses `{{GQL_URL}}`, it is saved as that env's `GQL_URL` (the label next to the box says which variable of which env you are editing); a request with its own URL saves it in the request file. Other env variables: **Edit env**.
- **Collection auth and headers:** hover the collection name → **Settings** → choose Auth (None / Bearer / Basic / API Key / Keycloak / other login) and add headers sent with every request.
- **Auth per env:** the Auth chosen in Settings belongs to the env that is selected — e.g. choose "None" on dev and test / prod keep Keycloak (the top line of the dialog shows what the other envs use). **Use this auth for every env** makes them all the same. In the file: `execution.auth` (shared) and `execution.authByEnv.<env>` (that env's own).
- Switching auth types does not lose what you typed (token, username, URL): it is kept in `.hyperion/auth-stash.json` and comes back when you pick that type again.
- **Collection variables:** the Variables section of collection Settings (like Postman). Use them as `{{name}}` in any request of the collection; env values override them. **Pull values from Postman** reads the current values of the same-named collection from Postman desktop. Values whose names look like a password / apiKey / token / cookie are moved to `secrets.local.yaml` automatically.
- Use env variables anywhere, e.g. Bearer token `{{TOKEN}}` with a different `TOKEN` per env (**Edit env**); put passwords as `{{secret:NAME}}` and keep the real value in `secrets.local.yaml`.
- **REST hosts per env:** a REST request with a host written into its URL shows "fixed host" next to the URL. **Use host per env** turns that host (and its short / long name) into an env variable in every request that uses it, e.g. `{{NODE_SERV}}/path`, and lets you set the host for each env. With dev selected, the label shows both hosts, e.g. `Dev: dev-api:8080 · Prod: prod-api:8080`.

## Request tabs (like Postman)

- **Query** — on the left, the schema's fields (loaded by itself). Open an object field: the first row **All fields (n)** ticks / unticks every plain field inside it. A field with arguments shows inputs; what you type goes to Variables and the argument is added to the query as a `$variable` (optional arguments have a checkbox). Ticking a field writes the query; unticking removes it; typing the query by hand updates the ticks. **«** folds the panel down to a "Schema" strip; drag its right edge to resize (double-click resets).
- **Authorization** — Inherit from collection (default), None, Bearer Token, Basic, API Key. A token can be an env variable such as `{{bearer_token}}`.
- **Headers** — this request's headers (same name as a collection header overrides it), plus the collection's headers for reference.
- **Scripts** — written in the app: **Pre-request** (before sending, e.g. `$req.headers.set(...)`) and **Post-response (tests)** (`$test`, `$expect`, `$res.status`, `$res.json`, `$res.timeMs`; keep a value with `$env.set`). Snippet buttons: Status is 200, No GraphQL errors, Field exists, Faster than 1 s, Save a value to a variable. An empty Tests tab has a **Write a test** button.
- Send uses what is in the tabs right away, even before it is saved.

## UI

- **Top bar:** pick the env. A `protected: true` env (prod) shows a red "Production — requests go to real data" bar. Sending a GraphQL mutation on prod asks **OK / Cancel** first (other envs, queries and REST go straight out); the CLI needs `--confirm <OpName>`.
- **Send to** (red) = where the request really goes · **Schema from** (amber) = where the autocomplete schema came from and when.
- Editor: autocomplete as you type, or `Ctrl+Space` · `Ctrl+Enter` sends · `Ctrl+S` saves.
- Resize: drag the request pane's right edge (request / response width) and the Variables bar (height); **Collapse** hides Variables.
- Response: fields listed in `masking.fields` of `_collection.yaml` are hidden; tick "Show patient data" to see real values.
- Token chip (top right, when a login is used): time left, **Renew** / **Clear**.
- **Import** — drop a Postman collection (v2.1) or environment (.json).

## Collections

| Task | In the UI | CLI |
| :--- | :--- | :--- |
| New collection | **+ Collection** — "Copy settings from" reuses auth / headers / schema | `hyperion new collection "Lab API" --from collections/main` |
| Add a request | hover the collection name → **+ request** | `hyperion new request collections/lab-api "Lab Results" --folder results` |
| Rename a request | click its name in the header | — |
| Move a request | **Move…** in the request header | `hyperion move <file.req.yaml> collections/lab-api` |
| Delete a request | **Delete** in the request header (click twice; goes to `.hyperion/trash`) | — |
| Split a folder into a collection | hover the folder name → **Split** | `hyperion split collections/main/pharmacy "Pharmacy API"` |

The sidebar has a section per collection type: **GraphQL**, **REST**, **gRPC**, **WebSocket** (with Socket.IO); collections can be folded. Splitting a folder copies the parent collection's settings and merges the folder's `_folder.yaml` into it; a moved request uses the destination collection's URL, auth and headers.

## Login with automatic token renewal (Keycloak / OpenID)

1. Hover the collection name → **Settings** → Auth: **Keycloak / OpenID**
2. Fill in the selected env's **Token URL** (e.g. `https://keycloak.example.org/realms/<realm>/protocol/openid-connect/token`), **Client ID**, **Username**, **Password**, **Client secret** (if the client has one)
3. **Test login** — shows "Got a token — valid for N more minutes · has a refresh token", or the reason it failed, e.g. "Invalid user credentials"
4. Other envs (test / prod): switch the env at the top and open **Settings** again to fill in that env's values

After that there is nothing to do: before each send, a token about to expire (30 s) is renewed with the refresh_token; if the refresh token has expired too, it logs in again with username / password; a 401 from the server renews and retries once. The token chip shows the time left.

- Token URL / Client ID / Username live in `envs/<env>.env.yaml` (`KC_*`); Password / Client secret only in `secrets.local.yaml` (gitignored).
- Tokens are kept in `envs/<env>.local.env.yaml` (gitignored).

## Other JSON logins

Auth: **Other login (JSON)** in Settings, or in `_collection.yaml` (an example is in the file as a comment): `execution.auth.type: tokenEndpoint`. Before each send, a token expiring within `skewSeconds` (60 s) is renewed via the refresh endpoint, else by logging in again; `ACCESS_TOKEN`, `REFRESH_TOKEN`, `TOKEN_EXPIRES_AT` are written to `envs/<env>.local.env.yaml` (gitignored). A 401 (token revoked) renews and retries once; parallel requests share one renewal.

## WebSocket, Socket.IO and gRPC

**+ Collection** → type **gRPC** (default URL `{{GRPC_ADDRESS}}`) or **WebSocket** (`{{WS_URL}}`) → **+ request** (a WebSocket collection offers WebSocket or Socket.IO). The editor holds the message to send (env `{{variables}}` work); the response pane is a live log, ↑ sent ↓ received (patient data masked as usual).

| Kind | How |
| :--- | :--- |
| WebSocket | `ws://` / `wss://` URL → **Connect** → **Send** the message in the editor → **Disconnect** · optional sub-protocol (e.g. `graphql-ws`) |
| Socket.IO | the server's `http(s)://` URL (no `/socket.io` needed) · **Event**, **Namespace** (e.g. `/admin`), **Wait for ack** · a JSON array message = several arguments, other JSON = one · on connect it sends the **Auth payload** you set, or `{"token": …}` from the Authorization Bearer |
| gRPC | URL = `host:port` (`grpcs://host:port` or tick **TLS**) · **.proto file** (relative to the project folder or a full path) → pick a **Method** → **Sample message** fills in JSON → **Invoke** · unary returns one answer with its status (`OK`, `UNAUTHENTICATED`, …); server streams show each message; client / bidi streams can **Send** more |

Auth and headers work as for other requests: WebSocket / Socket.IO send them as connection headers, gRPC as metadata (e.g. `authorization: Bearer …` from the collection's Keycloak login). These connections stay open in the app, so they cannot be used in flows or `hyperion run`. Try them in the demo: collections **Live (WebSocket)** and **Echo (gRPC)** talk to local mocks.

## SOAP

**+ Collection** → type **SOAP** (default URL `{{SOAP_URL}}`), or **Import** → "From a WSDL (SOAP)": paste the WSDL URL or file path and pick a collection (or a new SOAP collection, named after the service). Every operation becomes a request with a sample envelope (`<!-- optional -->`, `<!-- repeatable -->`, `<!-- choice -->` mark the WSDL rules), and `SOAP_URL` is set for the env if it was empty.

- The editor (**Envelope** tab) holds the XML sent; env `{{variables}}` work inside it. The SOAP bar: version **1.1 / 1.2**, **SOAPAction**, **WSDL** + **Load**, **Operation**, **Sample envelope** (asks before replacing an edited envelope).
- 1.1 sends `Content-Type: text/xml` + `SOAPAction`; 1.2 sends `application/soap+xml; action=…`. Auth and headers apply as for other requests (a header you set wins).
- Responses in XML are pretty-printed and highlighted (for every request kind); a SOAP Fault shows a red banner with its code and message. Patient fields are masked in XML too.
- Tests: `$res.xml("Tag")` reads the first element with that name (namespace prefix ignored), `$res.xmlAll("Tag")` all of them. Snippets: **No SOAP Fault**, **Read a value**.
- WSDL 1.1 (document/literal and rpc), imported WSDL / XSD files followed a few levels deep. Not supported: WSDL 2.0, WS-Security, MTOM attachments.
- Protected envs: the CLI asks for `--confirm` before operations whose name looks like a write (create, add, update, save, delete, cancel, submit, book, …).

## Flows (like Postman Flows)

- Sidebar **Flows** → **+ Flow** → **+ Block** picks a request from any collection → **Run** (Ctrl+Enter)
- Blocks run in order; values from `$flow.set(...)` / `pm.environment.set(...)` pass to the next block. Each block shows PASS / FAIL, status, time and tests — click it to see the response.
- **Condition** (optional), e.g. `$flow.get('visitId')` — when false the block is skipped · **Continue even if it fails** — the flow keeps going when this block fails.
- Protected envs (prod): the app runs mutations; `hyperion flow run` on the CLI stops at a mutation.
- Stored as `flows/<name>.flow.yaml`; run them in CI: `hyperion flow run flows/x.flow.yaml --env test --reporter junit`

## Import from Postman

- **Postman cannot export GraphQL-type requests.** Use **Import** → "Paste cURL / GraphQL query": copy Code (`</>`) → cURL from Postman (or Copy as cURL from the browser), or just the query, paste it, and pick the collection.
  - A Bearer token in the cURL is not written to the request file: it is kept in `envs/<env>.local.env.yaml` (gitignored) as `BEARER_TOKEN` and the request uses `{{BEARER_TOKEN}}`.
  - If the collection uses `{{GQL_URL}}` and the env has none yet, `GQL_URL` is set from the cURL's URL.
- **Read from Postman desktop:** Import → **Read from Postman** lists the GraphQL requests stored by the Postman app on this computer and imports the ones you pick.
- Collection files: GraphQL requests (GraphQL body or raw JSON with `query`) → `GraphQLRequest`, everything else → `HttpRequest`; folders stay folders; bearer / basic / apikey auth; `pm.*` scripts keep working (shim: `pm.test`, chai-style `pm.expect`, `pm.response`, `pm.environment`, `pm.sendRequest`).
- Environments: secret-type variables, or names like password / token / secret / apikey, move to `secrets.local.yaml` and are referenced as `{{secret:NAME}}`; envs whose name contains "prod" become protected.
- Not supported: collection / folder-level scripts, form-data bodies, the OAuth2 flow (converted to bearer `{{ACCESS_TOKEN}}`).

## CLI (works in GitLab CI)

```bash
node bin/hyperion.mjs run path/to/project/collections --env test --reporter junit --out report.xml
```

```text
hyperion init [dir]                                     new project (dev / test / prod / training)
hyperion run <file|dir>... [--env dev] [--var K=V] [--data rows.csv] [--confirm OpName] [-v] [--unmask]
hyperion schema sync <collectionDir> [--env] [--snapshot] [--reprobe]
hyperion schema export --url <graphql-url> [-H "K: V"] --out schema.graphql
hyperion token <status|refresh|clear> <collectionDir> [--env]
hyperion import <postman.json>... [--project dir]
hyperion new collection|request …   hyperion move …   hyperion split …
hyperion flow run <flows/x.flow.yaml> [--env test] [--reporter junit --out f]
hyperion serve [dir] [--port 4321] [--open]             no dir = last project
hyperion demo [--open]
hyperion shortcut                                       Windows: Desktop icon
```

In CI (the `CI` env var is set) tokens are not written to files; pass secrets as `HYPERION_SECRET_<NAME>`.

## Project layout

```
hyperion.yaml                        project name, defaultEnv, schemaEnv (optional)
envs/<env>.env.yaml                  variables per env (commit it — no secrets)
envs/<env>.local.env.yaml            tokens written by Hyperion (gitignored)
secrets.local.yaml                   passwords / keys (gitignored)
collections/<name>/_collection.yaml  type, execution (URL / auth / headers), variables, schemaDiscovery, masking
collections/<name>/**/_folder.yaml   folder-level auth / headers / variables
collections/<name>/**/*.req.yaml     query + variables + scripts
.hyperion/                           schema cache, state, trash (gitignored)
```

Variable precedence (low → high): `hyperion.yaml` < collection / folder / request < env < env.local < data row < flow < runtime.

## Tests

```bash
npm test
```

27 tests: schema fallback (including borrowing dev's schema), request-level and per-env auth, the schema explorer, flows, cURL paste, token renewal / 401 retry / single flight, Keycloak, schema drift, the prod guard, Postman import, the pm shim, creating / moving / splitting collections, WebSocket / Socket.IO / gRPC, REST hosts as env variables, scripts written in the app, and SOAP (WSDL import, 1.1 / 1.2, faults).

## About

Version 1.0.0 (V.01.00.00) · developer: soulrose
