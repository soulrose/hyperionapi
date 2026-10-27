// Hyperion UI — plain JS, no build step.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(`hyperion.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`hyperion.${k}`, v); } catch {} },
};

const state = { tree: null, env: null, req: null, result: null, schema: null, logs: [], root: null };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------- highlighting ----------
const GQL = /(#[^\n]*)|("""[\s\S]*?"""|"(?:\\.|[^"\\\n])*")|(\{\{[^}]*\}\})|(\$[A-Za-z_]\w*)|\b(query|mutation|subscription|fragment|on|true|false|null)\b|(:\s*)(\[?[A-Z]\w*)|(-?\d+(?:\.\d+)?)/g;
function hlGraphQL(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(GQL)) {
    out += esc(src.slice(last, m.index));
    const [all, com, str, tpl, v, kw, colon, type, num] = m;
    if (com) out += `<span class="t-com">${esc(com)}</span>`;
    else if (str) out += `<span class="t-str">${esc(str)}</span>`;
    else if (tpl) out += `<span class="t-tpl">${esc(tpl)}</span>`;
    else if (v) out += `<span class="t-var">${esc(v)}</span>`;
    else if (kw) out += `<span class="t-kw">${kw}</span>`;
    else if (type) out += `${esc(colon)}<span class="t-type">${esc(type)}</span>`;
    else if (num) out += `<span class="t-num">${num}</span>`;
    else out += esc(all);
    last = m.index + all.length;
  }
  return out + esc(src.slice(last)) + '\n';
}

const JSONRE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
function hlJSON(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(JSONRE)) {
    out += esc(src.slice(last, m.index));
    const [all, str, colon, lit, num] = m;
    if (str && colon) out += `<span class="t-key">${esc(str)}</span>${colon}`;
    else if (str) out += `<span class="t-str">${esc(str).replace(/\{\{[^}]*\}\}/g, (t) => `<span class="t-tpl">${t}</span>`)}</span>`;
    else if (lit) out += `<span class="t-kw">${lit}</span>`;
    else if (num) out += `<span class="t-num">${num}</span>`;
    last = m.index + all.length;
  }
  return out + esc(src.slice(last)) + '\n';
}

function bindEditor(textarea, code, hl) {
  const pre = code.parentElement;
  const paint = () => { code.innerHTML = hl(textarea.value); };
  textarea.addEventListener('input', paint);
  textarea.addEventListener('scroll', () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.defaultPrevented) {
      e.preventDefault();
      insertText(textarea, '  ');
    }
  });
  return paint;
}

function insertText(ta, text, caretBack = 0) {
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.setRangeText(text, s, e, 'end');
  ta.selectionStart = ta.selectionEnd = s + text.length - caretBack;
  ta.dispatchEvent(new Event('input'));
}

// realtime request kinds: the editor holds the message to send, the response pane a live message log
const RT = { WebSocketRequest: 'WebSocket', SocketIORequest: 'Socket.IO', GrpcRequest: 'gRPC' };
const isRt = (kind = state.req?.kind) => !!RT[kind];
const isGql = () => state.req?.kind === 'GraphQLRequest' || (state.req && !state.req.kind);

const paintQuery = bindEditor($('query'), $('queryHl'), (s) => (isRt() ? hlJSON(s) : hlGraphQL(s)));
const paintVars = bindEditor($('vars'), $('varsHl'), hlJSON);

// ---------- masking (same rule as the CLI) ----------
function mask(value, fields) {
  if (!fields?.length) return value;
  const set = new Set(fields.map((f) => f.toLowerCase()));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [
        k,
        set.has(k.toLowerCase()) && x != null && typeof x !== 'object' ? [...String(x)].map((c, i) => (i === 0 || c === ' ' ? c : '●')).join('') : walk(x),
      ]));
    }
    return v;
  };
  return walk(value);
}

// ---------- time helpers ----------
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีก่อน`;
  if (m < 1440) return `${Math.round(m / 60)} ชม.ก่อน`;
  return `${Math.round(m / 1440)} วันก่อน`;
};
const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
// personal-data fields hidden in flow results (each request's own collection list applies in the request view)
const DEFAULT_MASK = ['fullName', 'firstName', 'lastName', 'name', 'idCard', 'citizenId', 'phone', 'address'];

// ---------- tree + envs ----------
async function loadTree(pickFirst = true) {
  state.tree = await api('/api/tree');
  await renderProjects();
  document.body.classList.toggle('no-project', !!state.tree.noProject);
  if (state.tree.noProject) {
    state.req = null;
    document.body.classList.remove('protected');
    return;
  }
  $('projectName').textContent = state.tree.name;
  document.title = `${state.tree.name} — Hyperion API`;
  const envs = $('envs');
  envs.innerHTML = '';
  const saved = store.get(`env:${state.root}`);
  const initial = state.tree.envs.find((e) => e.name === saved)?.name ?? state.tree.defaultEnv;
  for (const e of state.tree.envs) {
    const b = document.createElement('button');
    b.role = 'radio';
    b.textContent = e.title ?? e.name;
    b.title = e.protected ? `${e.name} — protected: mutation ต้องยืนยันก่อนยิง` : e.name;
    b.className = e.protected ? 'protected' : '';
    b.dataset.env = e.name;
    b.onclick = () => selectEnv(e.name);
    envs.append(b);
  }
  renderSide();
  await selectEnv(initial, false);
  if (!pickFirst && state.view === 'flow' && state.tree.flows?.some((f) => f.file === state.flowFile)) return openFlow(state.flowFile);
  if (!pickFirst && state.req && state.tree.requests.some((r) => r.file === state.req.file)) return openRequest(state.req.file);
  const want = store.get(`req:${state.root}`);
  const first = state.tree.requests.find((r) => r.file === want) ?? state.tree.requests[0];
  if (first) await openRequest(first.file);
}

const foldedCols = () => {
  try {
    return new Set(JSON.parse(store.get(`folded:${state.root}`) || '[]'));
  } catch {
    return new Set();
  }
};

/**
 * graphql | rest | grpc | websocket: what _collection.yaml says, else what its requests are
 * (all REST → rest, all gRPC → grpc, all WebSocket / Socket.IO → websocket).
 */
function colType(col) {
  if (SECTIONS.includes(col.type)) return col.type;
  const kinds = state.tree.requests.filter((r) => r.collectionDir === col.dir).map((r) => r.kind);
  const all = (...ks) => kinds.length && kinds.every((k) => ks.includes(k));
  if (all('GrpcRequest')) return 'grpc';
  if (all('WebSocketRequest', 'SocketIORequest', 'GrpcRequest') || col.type === 'realtime') return 'websocket';
  return all('HttpRequest') ? 'rest' : 'graphql';
}
const SECTIONS = ['graphql', 'rest', 'grpc', 'websocket'];
const SECTION_LABEL = { graphql: 'GraphQL', rest: 'REST', grpc: 'gRPC', websocket: 'WebSocket' };
const COL_TYPES = SECTIONS.map((value) => ({ value, label: SECTION_LABEL[value] }));
// request kinds a new request can be in each collection type
const KINDS_OF = {
  graphql: [['GraphQLRequest', 'GraphQL'], ['HttpRequest', 'REST']],
  rest: [['HttpRequest', 'REST'], ['GraphQLRequest', 'GraphQL']],
  grpc: [['GrpcRequest', 'gRPC']],
  websocket: [['WebSocketRequest', 'WebSocket'], ['SocketIORequest', 'Socket.IO']],
};

function renderSide() {
  const q = $('filter').value.trim().toLowerCase();
  const tree = $('tree');
  tree.innerHTML = '';
  const cols = state.tree.collections ?? [];
  if (!cols.length) {
    tree.innerHTML = '<p class="empty">ยังไม่มี collection — สร้างใหม่ หรือ Import จาก Postman</p>';
    return renderFlowList(q);
  }
  // one section per type: GraphQL, REST, gRPC, WebSocket (with Socket.IO)
  const ordered = SECTIONS.flatMap((t) => cols.filter((c) => colType(c) === t));
  let section = null;
  for (const col of ordered) {
    const reqs = state.tree.requests.filter((r) => r.collectionDir === col.dir && (!q || `${r.name} ${r.file}`.toLowerCase().includes(q)));
    if (q && !reqs.length) continue;
    if (colType(col) !== section) {
      section = colType(col);
      tree.insertAdjacentHTML('beforeend', `<div class="side-section ${section}">${SECTION_LABEL[section]}</div>`);
    }
    const g = document.createElement('div');
    g.className = 'group';
    // fold / unfold a collection (remembered per project); searching shows matches even in folded ones
    const folded = foldedCols().has(col.dir) && !q;
    g.className = `group${folded ? ' folded' : ''}`;
    g.innerHTML = `<div class="group-head"><button class="col-fold" aria-expanded="${!folded}" title="ย่อ / ขยาย ${esc(col.name)}"><h3 title="${esc(col.dir)}">${esc(col.name)}</h3><small>${reqs.length}</small></button><button class="icon-btn col-settings" title="ชื่อ ชนิด URL auth headers และลบ ${esc(col.name)}">ตั้งค่า</button><button class="icon-btn col-add" title="เพิ่ม request ใน ${esc(col.name)}">+ request</button></div>`;
    g.querySelector('.col-fold').onclick = () => {
      const set = foldedCols();
      set.has(col.dir) ? set.delete(col.dir) : set.add(col.dir);
      store.set(`folded:${state.root}`, JSON.stringify([...set]));
      renderSide();
    };
    g.querySelector('.col-settings').onclick = () => editCollection(col);
    g.querySelector('.col-add').onclick = () => newRequest(col);
    if (folded) {
      tree.append(g);
      continue;
    }
    if (!reqs.length) {
      g.insertAdjacentHTML('beforeend', '<p class="group-empty">ว่าง — <button>เพิ่ม request แรก</button></p>');
      g.querySelector('.group-empty button').onclick = () => newRequest(col);
    }
    let folder = null;
    for (const r of reqs) {
      const f = r.file.slice(col.dir.length + 1).split('/').slice(0, -1).join('/');
      if (f && f !== folder) {
        const fh = document.createElement('div');
        fh.className = 'folder';
        fh.innerHTML = `<span>${esc(f.replaceAll('/', ' / '))}</span><button class="icon-btn" title="แยกโฟลเดอร์นี้ออกเป็น collection ใหม่">แยก</button>`;
        fh.querySelector('button').onclick = () => splitFolder(col, f);
        g.append(fh);
      }
      folder = f;
      const b = document.createElement('button');
      b.className = 'req';
      b.dataset.file = r.file;
      b.innerHTML = `<span class="op ${esc(r.op)}${RT[r.kind] ? ' rt' : ''}">${esc(r.op === 'mutation' ? 'mut' : r.op === 'query' ? 'qry' : r.op)}</span><span>${esc(r.name)}</span>`;
      b.onclick = () => openRequest(r.file);
      if (state.req?.file === r.file) b.setAttribute('aria-current', 'true');
      g.append(b);
    }
    tree.append(g);
  }
  renderFlowList(q);
}

// ---------- projects ----------
async function renderProjects() {
  const p = await api('/api/projects');
  state.root = p.current;
  state.projects = p;
  const list = p.projects.length ? p.projects : p.current ? [{ root: p.current, name: state.tree?.name ?? p.current }] : [];
  if (!p.current) $('projectName').textContent = 'ยังไม่ได้เปิดโปรเจกต์';
  const item = (pr) => `<button role="menuitem" data-root="${esc(pr.root)}"${pr.root === p.current ? ' aria-current="true"' : ''}><span>${esc(pr.name)}</span><small>${esc(pr.root)}</small></button>`;
  $('projectMenu').innerHTML = list.map(item).join('') + (list.length ? '<hr>' : '') +
    '<button role="menuitem" data-act="open"><span>เปิดโฟลเดอร์…</span></button><button role="menuitem" data-act="new"><span>สร้างโปรเจกต์ใหม่…</span></button><hr><button role="menuitem" data-act="about"><span>เกี่ยวกับ Hyperion</span></button>';
  $('recent').innerHTML = p.projects.map((pr) => `<li>${item(pr)}</li>`).join('');
}

function toggleMenu(open = $('projectMenu').hidden) {
  $('projectMenu').hidden = !open;
  $('projectBtn').setAttribute('aria-expanded', String(open));
  if (open) $('projectMenu').querySelector('button')?.focus();
}

async function showAbout() {
  toggleMenu(false);
  const a = await api('/api/about');
  $('aboutVersion').textContent = `เวอร์ชัน ${a.version}`;
  $('aboutDev').textContent = a.dev;
  $('aboutNode').textContent = `Node ${a.node.replace(/^v/, '')}`;
  $('aboutDlg').showModal();
  $('aboutClose').focus();
}
// closes from its own button / Esc / a click outside (the dialog's close event is not relied on)
$('aboutClose').onclick = () => $('aboutDlg').close();
$('aboutDlg').addEventListener('click', (e) => e.target === $('aboutDlg') && $('aboutDlg').close());

async function switchProject(root) {
  toggleMenu(false);
  if (root === state.root) return;
  await api('/api/project/open', { root });
  state.req = null;
  state.result = null;
  await loadTree();
}

async function openFolder() {
  toggleMenu(false);
  const r = await askForm({
    title: 'เปิดโฟลเดอร์โปรเจกต์',
    desc: 'วาง path ของโฟลเดอร์ที่มี hyperion.yaml (เช่นโฟลเดอร์ใน repo ของโปรเจกต์)',
    fields: [{ name: 'root', label: 'Path', value: state.projects?.home ? state.projects.home + state.projects.sep : '', required: true }],
    submit: 'เปิด',
    onSubmit: (v) => api('/api/project/open', v),
  });
  if (!r) return;
  state.req = null;
  await loadTree();
}

// folder name from a project name: keep letters (Thai too), drop characters Windows forbids
const folderName = (name) => name.trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-') || 'my-api';

async function newProject() {
  toggleMenu(false);
  const { home = '', sep = '\\', projects = [] } = state.projects ?? {};
  const taken = new Set(projects.map((p) => p.root.toLowerCase()));
  let name = 'My API';
  for (let i = 2; taken.has(`${home}${sep}${folderName(name)}`.toLowerCase()); i++) name = `My API ${i}`;
  let folderEdited = false;
  const r = await askForm({
    title: 'สร้างโปรเจกต์ใหม่',
    desc: 'สร้าง hyperion.yaml, env dev / test / prod / training และ collection ตัวอย่าง — ไฟล์ที่มีอยู่แล้วจะไม่ถูกทับ',
    fields: [
      { name: 'name', label: 'ชื่อโปรเจกต์', value: name, required: true },
      { name: 'root', label: 'โฟลเดอร์', value: `${home}${sep}${folderName(name)}`, required: true },
    ],
    submit: 'สร้างโปรเจกต์',
    // the folder follows the name until it is edited by hand
    onInput: (form, e) => {
      if (e.target.name === 'root') folderEdited = true;
      if (e.target.name === 'name' && !folderEdited) form.elements.root.value = `${home}${sep}${folderName(e.target.value)}`;
    },
    onSubmit: (v) => api('/api/project/new', v),
  });
  if (!r) return;
  state.req = null;
  await loadTree();
}

const onProjectClick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.root) switchProject(b.dataset.root);
  else if (b.dataset.act === 'open') openFolder();
  else if (b.dataset.act === 'new') newProject();
  else if (b.dataset.act === 'about') showAbout();
};
$('projectMenu').addEventListener('click', onProjectClick);
$('brand').onclick = showAbout;
$('recent').addEventListener('click', onProjectClick);
$('projectBtn').onclick = (e) => {
  e.stopPropagation();
  toggleMenu();
};
document.addEventListener('click', (e) => {
  if (!$('projectMenu').hidden && !e.target.closest('.project-pick')) toggleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('projectMenu').hidden) toggleMenu(false);
});
$('welcomeNew').onclick = newProject;
$('welcomeOpen').onclick = openFolder;

// ---------- env editor ----------
const kvRow = (k = '', v = '', focus = false) =>
  `<div class="kv-row"><input class="k" value="${esc(k)}" placeholder="NAME" aria-label="ชื่อตัวแปร" autocomplete="off" spellcheck="false">` +
  `<input class="v" value="${esc(v)}" placeholder="ค่า" aria-label="ค่า" autocomplete="off" spellcheck="false"${focus ? ' autofocus' : ''}>` +
  `<button type="button" class="icon-btn kv-rm" title="ลบตัวแปรนี้">ลบ</button></div>`;

$('formFields').addEventListener('click', (e) => {
  if (e.target.closest('.kv-rm')) {
    e.target.closest('.kv-row').remove();
    $('formDlgForm').dispatchEvent(new Event('input')); // a removed row is an edit too (autosave)
  }
  if (e.target.closest('.kv-add')) {
    e.target.closest('.kv-add').insertAdjacentHTML('beforebegin', kvRow());
    e.target.closest('.kv-edit').querySelector('.kv-row:last-of-type .k').focus();
  }
});

async function editEnv(focus) {
  if (!state.env) return;
  const e = await api(`/api/env?env=${encodeURIComponent(state.env.name)}`);
  const vars = { ...e.variables };
  if (focus && !Object.hasOwn(vars, focus)) vars[focus] = '';
  const saved = await askForm({
    title: `ตัวแปรของ ${e.title}`,
    desc: `บันทึกลง ${e.file} · URL ใส่เต็ม เช่น https://dev-host/graphql · รหัสผ่านใส่เป็น {{secret:NAME}} แล้วเก็บค่าจริงใน secrets.local.yaml`,
    fields: [
      { name: 'variables', type: 'kv', value: vars, focus },
      { name: 'protected', type: 'check', label: 'Protected — แสดงแถบเตือนสีแดงว่าเป็นข้อมูลจริง', value: e.protected },
    ],
    submit: 'บันทึก env',
    autosave: true,
    onSubmit: (v) => api('/api/env', { env: e.name, variables: v.variables, protected: v.protected }),
  });
  if (!saved) return;
  await loadTree(false);
}

// ---------- collection settings: URL, auth, headers ----------
const AUTH_TYPES = [
  { value: 'none', label: 'ไม่มี' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'basic', label: 'Basic' },
  { value: 'apiKey', label: 'API Key' },
  { value: 'keycloak', label: 'Keycloak / OpenID' },
  { value: 'tokenEndpoint', label: 'Login อื่น (JSON)' },
];

let deleteArmed = 0; // time of the first click on "ลบ collection นี้"

async function editCollection(col) {
  deleteArmed = 0;
  const s = await api(`/api/collection/settings?dir=${encodeURIComponent(col.dir)}&env=${encodeURIComponent(state.env.name)}`);
  const cur = typeof s.auth === 'object' && s.auth ? s.auth : { type: 'none' };
  const isKc = cur.type === 'tokenEndpoint' && cur.tokenEndpoint?.kind === 'keycloak';
  const type = isKc ? 'keycloak' : AUTH_TYPES.some((t) => t.value === cur.type) ? cur.type : 'none';
  // each kind prefills from what this env uses now, else from what it used before (switching back keeps the values)
  const pick = (kind) => (type === kind ? cur : s.stash?.[kind] ?? {});
  const bearer = pick('bearer').bearer ?? {};
  const basic = pick('basic').basic ?? {};
  const apiKey = pick('apiKey').apiKey ?? {};
  const te = pick('tokenEndpoint').tokenEndpoint ?? {};
  const kc = await api(`/api/auth/keycloak?env=${encodeURIComponent(state.env.name)}`);
  const envTitle = state.env.title ?? state.env.name;
  const otherEnvs = Object.entries(s.others ?? {})
    .map(([e, k]) => `${e} ${AUTH_TYPES.find((t) => t.value === k)?.label ?? k}`)
    .join(' · ');
  const show = (...types) => ({ field: 'authType', in: types });
  const saved = await askForm({
    title: `ตั้งค่า ${s.name}`,
    desc: `ใช้กับทุก request ใน collection นี้ · Auth ที่เลือกเป็นของ env ${envTitle} เท่านั้น${otherEnvs ? ` (env อื่น: ${otherEnvs})` : ''}`,
    actions: {
      // current values of the same-named collection in Postman desktop; the dialog reopens to show them
      fromPostman: async () => {
        const r = await api('/api/collection/vars/postman', { dir: col.dir });
        state.logs.push(`${new Date().toLocaleTimeString()}  ${s.name}: ดึง ${r.count} ตัวแปรจาก Postman${r.current ? ' (current value)' : ''}${r.secrets.length ? ` · ย้ายไป secrets.local.yaml: ${r.secrets.join(', ')}` : ''}`);
        renderLog();
        return { close: true, value: 'reopen' };
      },
      applyAll: async (v) => {
        await save(v, 'all');
        return { ok: true, text: 'ทุก env ใช้ auth นี้แล้ว' };
      },
      // log in now with what is in the form (it was just saved) and say how long the token lasts
      testLogin: async () => {
        const r = await api('/api/token', { file: col.dir, env: state.env.name, action: 'login' });
        refreshToken().catch(() => {});
        if (r.kind && r.kind !== 'tokenEndpoint') return { ok: false, text: 'collection นี้ยังไม่ได้ตั้งเป็น login' };
        if (r.error) return { ok: false, text: r.error };
        const left = r.expiresAt ? Math.round((Date.parse(r.expiresAt) - Date.now()) / 60000) : null;
        return { ok: true, text: `ได้ token แล้ว${left != null ? ` — ใช้ได้อีก ${left} นาที` : ''}${r.hasRefresh ? ' · มี refresh token (ต่ออายุเอง)' : ''}` };
      },
      // delete asks once more in place: the first click arms it, a second one within 6 s deletes
      deleteCol: async () => {
        const count = state.tree.requests.filter((r) => r.collectionDir === col.dir).length;
        if (!deleteArmed || Date.now() - deleteArmed > 6000) {
          deleteArmed = Date.now();
          return { ok: false, text: `กดอีกครั้งเพื่อยืนยัน — ลบ ${s.name} และ ${count} request (ย้ายไป .hyperion/trash กู้คืนได้)` };
        }
        const r = await api('/api/collection/delete', { dir: col.dir });
        state.logs.push(`${new Date().toLocaleTimeString()}  ลบ collection ${s.name} (${r.requests} request) → ${r.trash}${r.flowsUsing.length ? ` · flow ที่ใช้ request ในนี้: ${r.flowsUsing.join(', ')}` : ''}`);
        renderLog();
        if (state.req && state.req.file.startsWith(`${col.dir}/`)) state.req = null;
        return { close: true, value: 'deleted' };
      },
    },
    fields: [
      { name: 'colName', label: 'ชื่อ collection', value: s.name, required: true },
      { name: 'colType', label: 'ชนิด', type: 'seg', value: colType({ ...col, type: s.type }), options: COL_TYPES },
      { name: 'url', label: 'URL', value: s.url, placeholder: '{{GQL_URL}}' },
      { name: 'authType', label: 'Auth', type: 'seg', value: type, options: AUTH_TYPES },
      { name: 'bearerToken', label: 'Token (ส่งเป็น Authorization: Bearer …)', value: bearer.token ?? '{{TOKEN}}', show: show('bearer') },
      { name: 'basicUser', label: 'Username', value: basic.username ?? '{{APP_USER}}', show: show('basic') },
      { name: 'basicPass', label: 'Password', value: basic.password ?? '{{APP_PASSWORD}}', show: show('basic') },
      { name: 'apiKeyIn', label: 'ส่งใน', type: 'select', value: apiKey.in ?? 'header', options: [{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query string' }], show: show('apiKey') },
      { name: 'apiKeyName', label: 'ชื่อ', value: apiKey.name ?? 'X-API-Key', show: show('apiKey') },
      { name: 'apiKeyValue', label: 'ค่า', value: apiKey.value ?? '{{API_KEY}}', show: show('apiKey') },
      { name: 'kcTokenUrl', label: `Token URL (ของ env ${envTitle})`, value: kc.tokenUrl, placeholder: 'https://keycloak-…/realms/<realm>/protocol/openid-connect/token', show: show('keycloak') },
      { name: 'kcClientId', label: 'Client ID', value: kc.clientId, show: show('keycloak') },
      { name: 'kcUsername', label: 'Username', value: kc.username, show: show('keycloak') },
      { name: 'kcPassword', label: 'Password', type: 'password', value: '', placeholder: kc.hasPassword ? 'เก็บไว้แล้ว — เว้นว่างถ้าไม่เปลี่ยน' : 'เก็บใน secrets.local.yaml (ไม่เข้า Git)', show: show('keycloak') },
      { name: 'kcClientSecret', label: 'Client secret (ถ้า client มี)', type: 'password', value: '', placeholder: kc.hasClientSecret ? 'เก็บไว้แล้ว — เว้นว่างถ้าไม่เปลี่ยน' : 'ไม่บังคับ', show: show('keycloak') },
      { name: 'testLogin', label: 'ทดสอบ login', type: 'action', show: show('keycloak', 'tokenEndpoint') },
      { name: 'loginUrl', label: 'Login URL', value: te.url ?? '{{AUTH_URL}}', show: show('tokenEndpoint') },
      { name: 'loginBody', label: 'Body (JSON)', type: 'textarea', rows: 3, value: JSON.stringify(te.body ?? { username: '{{APP_USER}}', password: '{{APP_PASSWORD}}' }, null, 2), show: show('tokenEndpoint') },
      { name: 'tokenPath', label: 'Token อยู่ที่ field ไหนของ response', value: te.tokenPath ?? 'accessToken', show: show('tokenEndpoint') },
      { name: 'refreshUrl', label: 'Refresh URL (ไม่บังคับ)', value: te.refresh?.url ?? '', placeholder: '{{AUTH_URL}}/refresh', show: show('tokenEndpoint') },
      { name: 'applyAll', label: 'ใช้ auth นี้กับทุก env', type: 'action' },
      { name: 'headers', label: 'Headers (ส่งทุก request)', type: 'kv', value: s.headers, addLabel: '+ Header' },
      { name: 'variables', label: 'Variables ของ collection (ใช้เป็น {{ชื่อ}} — ค่าใน env ทับได้)', type: 'kv', value: s.variables, addLabel: '+ ตัวแปร' },
      { name: 'fromPostman', label: 'ดึงค่าจาก Postman', type: 'action' },
      { name: 'deleteCol', label: 'ลบ collection นี้', type: 'action', danger: true },
    ],
    submit: 'บันทึก',
    autosave: true,
    onSubmit: (v) => save(v),
  });
  if (saved === 'reopen') return editCollection(col);
  if (!saved) return;
  await loadTree(false);

  // the chosen auth is this env's own; scope 'all' makes every env use it
  async function save(v, scope) {
      const target = { dir: col.dir, env: state.env.name, scope };
      if (v.authType === 'keycloak') {
        // per-env values + secrets go through their own endpoint; the collection gets the Keycloak login
        await api('/api/auth/keycloak', { ...target, tokenUrl: v.kcTokenUrl, clientId: v.kcClientId, username: v.kcUsername, password: v.kcPassword, clientSecret: v.kcClientSecret });
        return api('/api/collection/settings', { dir: col.dir, name: v.colName, type: v.colType, url: v.url, headers: v.headers, variables: v.variables });
      }
      let auth = 'none';
      if (v.authType === 'bearer') auth = { type: 'bearer', bearer: { token: v.bearerToken } };
      if (v.authType === 'basic') auth = { type: 'basic', basic: { username: v.basicUser, password: v.basicPass } };
      if (v.authType === 'apiKey') auth = { type: 'apiKey', apiKey: { in: v.apiKeyIn, name: v.apiKeyName, value: v.apiKeyValue } };
      if (v.authType === 'tokenEndpoint') {
        let body;
        try {
          body = JSON.parse(v.loginBody || '{}');
        } catch {
          throw new Error('Body ของ Login ต้องเป็น JSON');
        }
        // keep settings this form does not show (saveToEnv, skewSeconds, ...)
        const next = { ...te, url: v.loginUrl, body, tokenPath: v.tokenPath || 'accessToken' };
        if (v.refreshUrl.trim()) next.refresh = { ...(te.refresh ?? { body: { refreshToken: '{{REFRESH_TOKEN}}' } }), url: v.refreshUrl.trim() };
        else delete next.refresh;
        auth = { type: 'tokenEndpoint', tokenEndpoint: next };
      }
      return api('/api/collection/settings', { ...target, name: v.colName, type: v.colType, url: v.url, auth, headers: v.headers, variables: v.variables });
  }
}

$('envEdit').onclick = () => editEnv('GQL_URL');
// URL bar autosave: env variable or the request's own URL
let urlTimer;
let urlSyncTimer;
$('execUrl').addEventListener('input', () => {
  clearTimeout(urlTimer);
  $('execUrl').classList.remove('unset');
  urlTimer = setTimeout(saveUrl, 700);
});
$('execUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    clearTimeout(urlTimer);
    saveUrl();
  }
});
async function saveUrl() {
  if (!state.req) return;
  const value = $('execUrl').value.trim();
  const v = state.req.urlVar;
  try {
    if (v) {
      await api('/api/env/var', { env: state.env.name, name: v.name, value });
      v.value = value;
    } else {
      await api('/api/save', { file: state.req.file, url: value });
      state.req.url = value;
    }
    if (!v) state.req.fixedHost = state.req.kind === 'HttpRequest' ? value.match(/^https?:\/\/[^/?#\s]+/i)?.[0] ?? null : null;
    $('urlSrc').textContent = 'บันทึกแล้ว';
    setTimeout(paintUrlSrc, 1500);
    // new URL: fetch its schema once typing has settled
    state.req.resolvedUrl = value;
    clearTimeout(urlSyncTimer);
    if (/^https?:\/\/[^<>{}\s]+$/.test(value)) urlSyncTimer = setTimeout(() => autoSyncSchema(true), 1500);
  } catch (err) {
    $('urlSrc').textContent = `บันทึกไม่ได้: ${err.message}`;
  }
}

// the label next to the URL: which env variable it edits, or that a REST host is fixed (does not follow the env)
function paintUrlSrc() {
  const r = state.req;
  const envTitle = state.env.title ?? state.env.name;
  const src = $('urlSrc');
  src.className = 'url-src';
  src.title = '';
  $('hostVar').hidden = !r?.fixedHost;
  if (!r) return;
  if (r.urlVar) src.textContent = `${r.urlVar.name} · ${envTitle}`;
  else if (r.fixedHost) {
    src.textContent = 'host ตายตัว';
    src.title = 'URL นี้เขียน host ไว้ในไฟล์ — เลือก dev / test / prod ก็ยิงไปที่เดิม · กด "ใช้ host ตาม env" เพื่อแยกตาม env';
    src.classList.add('warn');
  } else if (r.hostVar) {
    // this env's host, and prod's host beside it when another env is picked
    // short machine name: "prod-api:8080" (the full URL is in the tooltip)
    const host = (u) => u.replace(/^[a-z]+:\/\//i, '').replace(/^([^.:/]+)[^:/]*/, '$1').replace(/\/.*$/, '');
    const p = r.hostVar.prod;
    const prodPart = p && !state.env.protected ? ` · ${p.env}: ${p.value ? host(p.value) : 'ยังไม่ได้ตั้ง'}` : '';
    src.textContent = `${envTitle}: ${r.hostVar.value ? host(r.hostVar.value) : 'ยังไม่ได้ตั้ง'}${prodPart}`;
    src.title = `${r.hostVar.name} = ${r.hostVar.value || '(ยังไม่ได้ตั้ง)'}${p && !state.env.protected ? `\n${p.env}: ${p.value || '(ยังไม่ได้ตั้ง)'}` : ''}\nคลิกเพื่อแก้ค่าใน env`;
    src.classList.add('link');
    if (!r.hostVar.value) src.classList.add('warn');
  } else src.textContent = 'ใน request';
}
$('urlSrc').onclick = () => state.req?.hostVar && !state.req.urlVar && editEnv(state.req.hostVar.name);

// REST host → env variable: every request using that host (and its short / long name) gets {{NAME}}/path
async function hostToVar() {
  const r = state.req;
  const host = r?.fixedHost;
  if (!host) return;
  const { hosts } = await api('/api/hosts');
  const u = new URL(host);
  const first = u.hostname.split('.')[0];
  // the same machine written as "dev-api" and "dev-api.example.org" (same port)
  const same = hosts.filter((h) => {
    try {
      const x = new URL(h.origin);
      return x.protocol === u.protocol && x.port === u.port && x.hostname.split('.')[0] === first;
    } catch {
      return false;
    }
  });
  if (!same.some((h) => h.origin === host)) same.unshift({ origin: host, count: 1 });
  const suggested = `${first}${u.port ? `_${u.port}` : ''}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const envTitle = state.env.title ?? state.env.name;
  const looksProd = /(^|[-.])prod/i.test(u.hostname) && !state.env.protected;
  const made = await askForm({
    title: 'ใช้ host ตาม env',
    desc: `URL ที่ขึ้นต้นด้วย host ที่ติ๊กจะกลายเป็น {{ชื่อตัวแปร}}/path แล้วแต่ละ env ใส่ host ของตัวเอง — env ที่เว้นว่างใส่ทีหลังได้ที่ แก้ env${looksProd ? ` · host นี้ดูเหมือนของ prod แต่ตอนนี้เลือก ${envTitle} อยู่ — ตรวจช่อง ${envTitle} ให้ถูก` : ''}`,
    fields: [
      { name: 'name', label: 'ชื่อตัวแปร', value: suggested, required: true },
      ...same.map((h, i) => ({ name: `h${i}`, type: 'check', label: `${h.origin} (${h.count} request)`, value: true })),
      ...state.tree.envs.map((e) => ({
        name: `env_${e.name}`,
        label: `host ของ ${e.title ?? e.name}${e.name === state.env.name ? ' (env ที่เลือกอยู่)' : ''}`,
        value: e.name === state.env.name ? host : '',
        placeholder: 'http://…:8080 (เว้นว่างได้)',
      })),
    ],
    submit: 'เปลี่ยน',
    onSubmit: (v) =>
      api('/api/host/to-var', {
        name: v.name.trim(),
        env: state.env.name,
        value: v[`env_${state.env.name}`],
        hosts: same.filter((_, i) => v[`h${i}`]).map((h) => h.origin),
        values: Object.fromEntries(state.tree.envs.map((e) => [e.name, v[`env_${e.name}`]])),
      }),
  });
  if (!made) return;
  state.logs.push(`${new Date().toLocaleTimeString()}  host → {{${made.name}}} ใน ${made.changed} request`);
  renderLog();
  await loadTree(false);
  await openRequest(r.file);
}
$('hostVar').onclick = hostToVar;

// ---------- small form dialog (resolves from its own buttons) ----------
function askForm({ title, desc = '', fields, submit, onSubmit, onInput, autosave = false, actions = {}, danger = false }) {
  const dlg = $('formDlg');
  $('formTitle').textContent = title;
  $('formDesc').textContent = desc;
  $('formDesc').hidden = !desc;
  $('formOk').textContent = submit;
  $('formError').hidden = true;
  const fieldHtml = (f) => {
      if (f.type === 'select') {
        return `<label>${esc(f.label)}<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      }
      if (f.type === 'seg') {
        return `<div class="seg" role="radiogroup" aria-label="${esc(f.label)}">${f.options.map((o) => `<label><input type="radio" name="${f.name}" value="${esc(o.value)}"${o.value === f.value ? ' checked' : ''}>${esc(o.label)}</label>`).join('')}</div>`;
      }
      if (f.type === 'textarea') {
        return `<label>${esc(f.label)}<textarea name="${f.name}" rows="${f.rows ?? 4}" spellcheck="false">${esc(f.value ?? '')}</textarea></label>`;
      }
      if (f.type === 'check') {
        return `<label class="check"><input type="checkbox" name="${f.name}"${f.value ? ' checked' : ''}> ${esc(f.label)}</label>`;
      }
      if (f.type === 'kv') {
        // editable NAME = value rows; collected into values[f.name] on submit
        return `${f.label ? `<div class="kv-label">${esc(f.label)}</div>` : ''}<div class="kv-edit" data-name="${f.name}">${Object.entries(f.value ?? {}).map(([k, v]) => kvRow(k, v, k === f.focus)).join('')}<button type="button" class="ghost small kv-add">${esc(f.addLabel ?? '+ ตัวแปร')}</button></div>`;
      }
      if (f.type === 'action') {
        // a button inside the form (e.g. "ทดสอบ login") with a line for its result
        return `<div class="form-action${f.danger ? ' danger-zone' : ''}"><button type="button" class="ghost small${f.danger ? ' ghost-danger' : ''}" data-action="${f.name}">${esc(f.label)}</button><span class="action-out" data-out="${f.name}"></span></div>`;
      }
      return `<label>${esc(f.label)}<input name="${f.name}"${f.type === 'password' ? ' type="password"' : ''} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}"${f.required ? ' required' : ''}></label>`;
  };
  // f.show = { field, in: [...] }: only visible while that (radio) field has one of those values
  $('formFields').innerHTML = fields
    .map((f) => (f.show ? `<div class="fields" data-show-field="${f.show.field}" data-show-in="${f.show.in.join(',')}">${fieldHtml(f)}</div>` : fieldHtml(f)))
    .join('');
  const applyShow = () => {
    const form = $('formDlgForm');
    for (const el of form.querySelectorAll('[data-show-field]')) {
      el.hidden = !el.dataset.showIn.split(',').includes(form.elements[el.dataset.showField]?.value ?? '');
    }
  };
  applyShow();
  dlg.showModal();
  const first = dlg.querySelector('[autofocus]') ?? dlg.querySelector('input:not([type=radio]):not([type=checkbox]), select');
  first?.focus();
  first?.select?.(); // a prefilled default is replaced by typing
  if (!first) $('formOk').focus(); // a plain question: Enter = the main button
  // a question about real (production) data: red main button
  $('formOk').classList.toggle('danger', !!danger);
  $('formOk').classList.toggle('primary', !danger);
  // autosave dialogs (env, collection settings): every edit is saved; the only button is "ปิด"
  $('formCancel').hidden = !!autosave;
  if (autosave) $('formOk').textContent = 'ปิด';
  return new Promise((resolve) => {
    const form = $('formDlgForm');
    const collect = () => {
      const values = Object.fromEntries(new FormData(form));
      for (const box of form.querySelectorAll('input[type=checkbox]')) values[box.name] = box.checked;
      for (const kv of form.querySelectorAll('.kv-edit')) {
        values[kv.dataset.name] = Object.fromEntries(
          [...kv.querySelectorAll('.kv-row')].map((r) => [r.querySelector('.k').value.trim(), r.querySelector('.v').value]).filter(([k]) => k),
        );
      }
      return values;
    };
    const status = (text, isError) => {
      $('formError').textContent = text;
      $('formError').classList.toggle('ok', !isError);
      $('formError').hidden = !text;
    };
    let timer;
    let saved = null;
    const autoSave = async () => {
      clearTimeout(timer);
      try {
        saved = await onSubmit(collect());
        status(`บันทึกแล้ว ${new Date().toLocaleTimeString()}`);
      } catch (err) {
        status(err.message, true);
      }
    };
    form.oninput = (e) => {
      applyShow();
      onInput?.(form, e);
      if (autosave) {
        clearTimeout(timer);
        timer = setTimeout(autoSave, 600);
      }
    };
    // action buttons: save what is in the form first (autosave dialogs), then run the action
    form.onclick = async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !actions[btn.dataset.action]) return;
      const out = form.querySelector(`[data-out="${btn.dataset.action}"]`);
      btn.disabled = true;
      out.className = 'action-out';
      out.textContent = 'กำลังทำ…';
      try {
        if (autosave) await autoSave();
        const r = await actions[btn.dataset.action](collect());
        if (r?.close) return done(r.value ?? null);
        out.textContent = r?.text ?? 'สำเร็จ';
        out.classList.add(r?.ok === false ? 'bad' : 'good');
      } catch (err) {
        out.textContent = err.message;
        out.classList.add('bad');
      } finally {
        btn.disabled = false;
      }
    };
    const done = (v) => {
      clearTimeout(timer);
      form.onsubmit = form.oninput = form.onclick = $('formCancel').onclick = dlg.oncancel = null;
      $('formCancel').hidden = false;
      $('formError').classList.remove('ok');
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('formCancel').onclick = () => done(null);
    dlg.oncancel = async (e) => {
      if (!autosave) return done(null);
      e.preventDefault(); // Esc on an autosave dialog: save what is there, then close
      await autoSave();
      done(saved);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        done(await onSubmit(collect()));
      } catch (err) {
        status(err.message, true);
      }
    };
  });
}

const colOptions = (withNone) => [
  ...(withNone ? [{ value: '', label: 'ไม่คัดลอก — เริ่มจากค่าว่าง' }] : []),
  ...(state.tree.collections ?? []).map((c) => ({ value: c.dir, label: c.name })),
];

async function newCollection() {
  const from = state.req ? state.tree.requests.find((r) => r.file === state.req.file)?.collectionDir : state.tree.collections?.[0]?.dir;
  const made = await askForm({
    title: 'Collection ใหม่',
    desc: 'คัดลอก auth, headers และแหล่ง schema จาก collection ที่มีอยู่ได้ ไม่ต้องตั้ง login ใหม่',
    fields: [
      { name: 'type', label: 'ชนิด', type: 'seg', value: 'graphql', options: COL_TYPES },
      { name: 'name', label: 'ชื่อ', placeholder: 'เช่น Pharmacy API', required: true },
      { name: 'from', label: 'คัดลอกการตั้งค่าจาก', type: 'select', options: colOptions(true), value: from ?? '' },
      { name: 'url', label: 'URL', placeholder: 'เว้นว่าง = ใช้ของ collection ต้นแบบ หรือ {{GQL_URL}} / {{BASE_URL}}' },
    ],
    submit: 'สร้าง collection',
    onSubmit: (v) => api('/api/collection', { name: v.name, type: v.type, from: v.from || undefined, url: v.url || undefined }),
  });
  if (!made) return;
  await loadTree(false);
  await newRequest(made);
}

async function newRequest(col) {
  const made = await askForm({
    title: `Request ใหม่ใน ${col.name}`,
    fields: [
      { name: 'kind', label: 'ชนิด', type: 'seg', value: KINDS_OF[colType(col)][0][0], options: KINDS_OF[colType(col)].map(([value, label]) => ({ value, label })) },
      { name: 'name', label: 'ชื่อ', placeholder: 'เช่น Get Lab Results', required: true },
      { name: 'folder', label: 'โฟลเดอร์ (ไม่บังคับ)', placeholder: 'เช่น lab' },
    ],
    submit: 'สร้าง request',
    onSubmit: (v) => api('/api/request/new', { collection: col.dir, ...v }),
  });
  if (!made) return;
  await loadTree(false);
  await openRequest(made.file);
  $('query').focus();
}

async function moveCurrent() {
  const current = state.tree.requests.find((r) => r.file === state.req.file);
  const others = (state.tree.collections ?? []).filter((c) => c.dir !== current?.collectionDir);
  if (!others.length) return newCollection();
  const moved = await askForm({
    title: `ย้าย "${state.req.name}"`,
    desc: 'request จะใช้ URL, auth และ headers ของ collection ปลายทาง',
    fields: [
      { name: 'collection', label: 'ไปที่ collection', type: 'select', options: others.map((c) => ({ value: c.dir, label: c.name })) },
      { name: 'folder', label: 'โฟลเดอร์ (ไม่บังคับ)', placeholder: 'เช่น lab' },
    ],
    submit: 'ย้าย',
    onSubmit: (v) => api('/api/request/move', { file: state.req.file, ...v }),
  });
  if (!moved) return;
  state.req.file = moved.file;
  await loadTree(false);
}

async function splitFolder(col, folder) {
  const count = state.tree.requests.filter((r) => r.file.startsWith(`${col.dir}/${folder}/`)).length;
  const made = await askForm({
    title: `แยก "${folder}" เป็น collection ใหม่`,
    desc: `ย้าย ${count} request ออกจาก ${col.name} — collection ใหม่ใช้ auth, headers และ schema แบบเดียวกับ ${col.name} แก้ทีหลังได้`,
    fields: [{ name: 'name', label: 'ชื่อ collection ใหม่', value: `${col.name} ${folder.split('/').at(-1)}`, required: true }],
    submit: 'แยก collection',
    onSubmit: (v) => api('/api/collection/split', { folder: `${col.dir}/${folder}`, name: v.name }),
  });
  if (!made) return;
  const prefix = `${col.dir}/${folder}/`;
  if (state.req?.file.startsWith(prefix)) state.req.file = `${made.dir}/${state.req.file.slice(prefix.length)}`;
  await loadTree(false);
}

async function selectEnv(name, reload = true) {
  state.env = state.tree.envs.find((e) => e.name === name) ?? state.tree.envs[0];
  store.set(`env:${state.root}`, state.env.name);
  document.body.classList.toggle('protected', !!state.env.protected);
  for (const b of $('envs').children) b.setAttribute('aria-checked', String(b.dataset.env === state.env.name));
  if (reload && state.req) await openRequest(state.req.file);
}

// ---------- request ----------
async function openRequest(file) {
  const r = await api(`/api/request?file=${encodeURIComponent(file)}&env=${encodeURIComponent(state.env.name)}`);
  state.req = r;
  state.view = 'request';
  document.body.classList.remove('flow-mode');
  store.set(`req:${state.root}`, file);
  for (const b of document.querySelectorAll('.req')) b.toggleAttribute('aria-current', b.dataset.file === file);
  for (const b of document.querySelectorAll('.req[aria-current]')) b.setAttribute('aria-current', 'true');
  $('reqName').textContent = r.name;
  const op = r.kind === 'HttpRequest' ? r.method : RT[r.kind] ?? r.op;
  $('opBadge').hidden = !op;
  $('opBadge').className = `op ${op}${RT[r.kind] ? ' rt' : ''}`;
  $('opBadge').textContent = op === 'mutation' ? 'mutation' : op === 'query' ? 'query' : op;
  $('method').textContent = r.kind === 'HttpRequest' ? r.method : RT[r.kind] ? { WebSocketRequest: 'WS', SocketIORequest: 'SIO', GrpcRequest: 'gRPC' }[r.kind] : 'POST';
  // URL bar: edits the env variable when the URL is exactly {{VAR}}, otherwise the request's own URL
  const envTitle = state.env.title ?? state.env.name;
  const v = r.urlVar;
  const placeholderUrl = v && (!v.value || /<[^>]+>/.test(v.value)); // still the template's <dev-host>
  $('execUrl').disabled = false;
  $('execUrl').value = v ? (placeholderUrl ? '' : v.value) : r.url ?? '';
  $('execUrl').placeholder = v ? `ใส่ URL ของ ${envTitle} เช่น https://dev-host/graphql` : 'https://…';
  $('execUrl').title = v ? `ค่า ${v.name} ของ env ${envTitle} — แก้แล้วบันทึกให้เอง` : 'URL ของ request นี้ — แก้แล้วบันทึกให้เอง';
  paintUrlSrc();
  $('execUrl').classList.toggle('unset', !!placeholderUrl);
  $('query').value = r.kind === 'HttpRequest' ? JSON.stringify(r.body ?? null, null, 2) : RT[r.kind] ? r.rt?.message ?? '' : r.query;
  $('vars').value = JSON.stringify(r.variables ?? {}, null, 2);
  fillRt(r);
  paintQuery();
  paintVars();
  $('send').disabled = false;
  $('save').textContent = 'บันทึกอัตโนมัติ';
  $('move').disabled = false;
  $('delReq').disabled = false;
  disarmDelete();
  $('sync').disabled = !isGql();
  const s = r.scripts ?? {};
  $('scriptsDot').hidden = !s.beforeRequest && !s.afterResponse;
  $('scriptsBody').innerHTML =
    ['beforeRequest', 'afterResponse']
      .filter((k) => s[k])
      .map((k) => `<h4>${k}</h4><pre>${esc(s[k])}</pre>`)
      .join('') || '<p class="hint">request นี้ไม่มี script — เขียนได้ในไฟล์ .req.yaml ส่วน scripts:</p>';
  fillAuth(r.auth, r.inheritedAuth);
  fillHeaders(r.headers, r.inheritedHeaders);
  r.authKey = JSON.stringify([readAuth(), readHeaders()]); // to notice a token change later
  await Promise.all([refreshSchema(), refreshToken()]);
  resetExplorer();
  validateSoon();
  autoSyncSchema();
}

async function refreshSchema() {
  if (!state.req || !isGql()) {
    $('schemaStatus').textContent = isRt() ? `${RT[state.req.kind]} — ไม่ใช้ GraphQL schema` : 'REST request — ไม่ใช้ schema';
    return;
  }
  const { meta } = await api(`/api/schema?file=${encodeURIComponent(state.req.file)}&env=${encodeURIComponent(state.env.name)}`);
  state.schema = meta;
  const label = { fallback: 'SCHEMA_URL', target: `${state.env.name} เอง`, snapshot: 'Offline snapshot' };
  $('schemaStatus').innerHTML = meta
    ? `<b>${esc(label[meta.source] ?? `env ${meta.source}`)}</b>${meta.borrowed ? ' (ยืม cache)' : ''} · ${meta.types ?? '?'} types${meta.fetchedAt ? ` · ดึงล่าสุด ${ago(meta.fetchedAt)}` : ''}${meta.hash ? ` · sha ${esc(meta.hash)}` : ''}${meta.stale ? ' · <span class="drift">cache หมดอายุ</span>' : ''}${
        meta.targetRejected && /40[13]/.test(meta.targetRejected)
          ? ` · <span class="drift">${esc(state.env.name)} ตอบ ${esc(meta.targetRejected)} — ใส่ token ในแท็บ Authorization แล้วจะโหลด schema ของ ${esc(state.env.name)} เอง</span>`
          : ''
      }`
    : /<[^>]+>|\{\{/.test(state.req.resolvedUrl ?? '<') ? 'ยังไม่มี schema — ใส่ URL ในช่องด้านบน แล้ว schema จะโหลดเอง' : 'ยังไม่มี schema';
}

async function refreshToken() {
  const t = await api(`/api/token?file=${encodeURIComponent(state.req.file)}&env=${encodeURIComponent(state.env.name)}`);
  const box = $('token');
  box.hidden = t.kind !== 'tokenEndpoint';
  if (box.hidden) return;
  box.classList.remove('warn', 'bad');
  if (!t.hasToken) {
    $('tokenText').textContent = 'ยังไม่มี token — จะ login ให้ตอนกด Send';
    box.classList.add('warn');
  } else if (t.expiresAt) {
    const left = Math.round((Date.parse(t.expiresAt) - Date.now()) / 60000);
    $('tokenText').textContent = left > 0 ? `token เหลือ ${left} นาที` : `token หมดอายุ — จะ${t.hasRefresh ? 'ต่ออายุ' : ' login ใหม่'}อัตโนมัติตอนยิง`;
    if (left <= 0) box.classList.add('warn');
  } else $('tokenText').textContent = 'มี token (ไม่ทราบเวลาหมดอายุ)';
  $('tokenText').title = `เก็บใน ${state.env.name}.local.env.yaml → ${t.varName}`;
}

// ---------- validation ----------
let vTimer;
function validateSoon() {
  clearTimeout(vTimer);
  vTimer = setTimeout(validate, 350);
}
async function validate() {
  // keep the explorer's ticks in line with what is typed
  updateSelected().then(() => !$('explorer').hidden && renderExplorer());
  const lint = $('lint');
  lint.innerHTML = '';
  if (!state.req) return;
  const notes = [];
  try {
    JSON.parse($('vars').value || '{}');
  } catch (e) {
    notes.push(`Variables ไม่ใช่ JSON ที่ถูกต้อง: ${e.message}`);
  }
  if (isGql()) {
    const { errors } = await api('/api/validate', { file: state.req.file, env: state.env.name, query: $('query').value });
    notes.push(...errors);
  }
  lint.innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
}

// ---------- autocomplete ----------
const ac = { items: [], index: 0, prefix: '' };
function caretXY(ta) {
  const mirror = document.createElement('div');
  const cs = getComputedStyle(ta);
  for (const p of ['font', 'padding', 'border', 'whiteSpace', 'tabSize', 'lineHeight', 'letterSpacing']) mirror.style[p] = cs[p];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: `${ta.clientWidth}px`, whiteSpace: 'pre' });
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.append(mark);
  document.body.append(mirror);
  const r = { x: mark.offsetLeft - ta.scrollLeft, y: mark.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight) };
  mirror.remove();
  return r;
}

async function openAc(force = false) {
  const ta = $('query');
  if (!state.req || !isGql()) return;
  const res = await api('/api/complete', { file: state.req.file, env: state.env.name, query: ta.value, offset: ta.selectionStart });
  if (!res.items?.length || (!force && !res.prefix)) return closeAc();
  ac.items = res.items;
  ac.index = 0;
  ac.prefix = res.prefix;
  const list = $('ac');
  const src = state.schema ? `${res.type} · จาก ${state.schema.source === 'fallback' ? 'Dev' : state.schema.source}` : res.type;
  list.innerHTML = `<li class="ac-src">${esc(src)}</li>` + res.items
    .map((it, i) => `<li role="option" data-i="${i}" class="${it.deprecated ? 'deprecated' : ''}" aria-selected="${i === 0}" title="${esc(it.doc || it.args.join(', '))}"><span>${esc(it.label)}</span><small>${esc(it.detail)}</small></li>`)
    .join('');
  const { x, y } = caretXY(ta);
  Object.assign(list.style, { left: `${Math.min(x, ta.clientWidth - 270)}px`, top: `${y + 4}px` });
  list.hidden = false;
}
function closeAc() {
  $('ac').hidden = true;
  ac.items = [];
}
function pickAc(i = ac.index) {
  const it = ac.items[i];
  if (!it) return;
  const ta = $('query');
  ta.selectionStart -= ac.prefix.length;
  const indent = ta.value.slice(0, ta.selectionStart).split('\n').at(-1).match(/^\s*/)[0];
  if (it.hasSelection) insertText(ta, `${it.label} {\n${indent}  \n${indent}}`, indent.length + 2);
  else insertText(ta, it.label);
  closeAc();
  validateSoon();
}
function moveAc(d) {
  ac.index = (ac.index + d + ac.items.length) % ac.items.length;
  for (const li of $('ac').querySelectorAll('[role=option]')) li.setAttribute('aria-selected', String(Number(li.dataset.i) === ac.index));
  $('ac').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}
$('ac').addEventListener('mousedown', (e) => {
  const li = e.target.closest('[role=option]');
  if (li) {
    e.preventDefault();
    pickAc(Number(li.dataset.i));
  }
});
$('query').addEventListener('keydown', (e) => {
  if (!$('ac').hidden) {
    if (e.key === 'ArrowDown') return void (e.preventDefault(), moveAc(1));
    if (e.key === 'ArrowUp') return void (e.preventDefault(), moveAc(-1));
    if (e.key === 'Enter' || e.key === 'Tab') return void (e.preventDefault(), pickAc());
    if (e.key === 'Escape') return void (e.preventDefault(), closeAc());
  }
  if (e.key === ' ' && e.ctrlKey) {
    e.preventDefault();
    openAc(true);
  }
});
let acTimer;
$('query').addEventListener('input', (e) => {
  validateSoon();
  clearTimeout(acTimer);
  if (e.inputType?.startsWith('insert') && /\w$/.test($('query').value.slice(0, $('query').selectionStart))) acTimer = setTimeout(() => openAc(), 120);
  else closeAc();
});
$('query').addEventListener('blur', () => setTimeout(closeAc, 150));
$('vars').addEventListener('input', validateSoon);

// ---------- realtime: WebSocket / Socket.IO / gRPC ----------
// one live connection per request file: { id, kind, log, status, canSend, result?, es }
state.rt = {};
const rtConn = () => (state.req ? state.rt[state.req.file] : null);
const RT_SHORT = { WebSocketRequest: 'ws', SocketIORequest: 'sio', GrpcRequest: 'grpc' };

function fillRt(r) {
  document.body.classList.toggle('rt-mode', !!RT[r.kind]);
  $('rtBar').hidden = !RT[r.kind];
  if (!RT[r.kind]) {
    $('rtClose').hidden = true;
    $('send').innerHTML = 'Send <kbd>Ctrl+Enter</kbd>';
    return;
  }
  for (const el of $('rtBar').querySelectorAll('[data-rt]')) el.hidden = el.dataset.rt !== RT_SHORT[r.kind];
  const x = r.rt ?? {};
  $('rtProtocols').value = [].concat(x.protocols ?? []).join(', ');
  $('rtEvent').value = x.event ?? '';
  $('rtNamespace').value = x.namespace ?? '';
  $('rtAck').checked = !!x.ack;
  $('rtAuthPayload').value = typeof x.authPayload === 'string' ? x.authPayload : x.authPayload ? JSON.stringify(x.authPayload) : '';
  $('rtProto').value = x.proto ?? '';
  $('rtTls').checked = !!x.tls;
  const cur = x.service && x.method ? `${x.service}/${x.method}` : '';
  $('rtMethod').innerHTML = cur ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '';
  $('rtHint').textContent = '';
  if (r.kind === 'GrpcRequest') loadProto();
  rtPaint();
}

function readRt() {
  const out = { message: $('query').value };
  const k = state.req.kind;
  if (k === 'WebSocketRequest') out.protocols = $('rtProtocols').value.trim();
  if (k === 'SocketIORequest') {
    Object.assign(out, { event: $('rtEvent').value.trim(), namespace: $('rtNamespace').value.trim(), ack: $('rtAck').checked, authPayload: $('rtAuthPayload').value.trim() });
  }
  if (k === 'GrpcRequest') {
    // a service name has dots but no "/"
    const [service = '', method = ''] = ($('rtMethod').value || '').split('/');
    Object.assign(out, { proto: $('rtProto').value.trim(), service, method, tls: $('rtTls').checked });
  }
  return out;
}

// services / methods of the .proto, for the Method list (the example message comes from here too)
let protoInfo = [];
async function loadProto(reload = false) {
  const proto = $('rtProto').value.trim();
  protoInfo = [];
  if (!proto) {
    $('rtHint').textContent = 'ใส่ path ของไฟล์ .proto แล้วเลือก method';
    return;
  }
  try {
    const { services } = await api(`/api/grpc/describe?file=${encodeURIComponent(state.req.file)}&env=${encodeURIComponent(state.env.name)}&proto=${encodeURIComponent(proto)}${reload ? '&reload=1' : ''}`);
    protoInfo = services;
    const cur = $('rtMethod').value;
    const kindOf = (m) => (m.requestStream && m.responseStream ? ' · bidi stream' : m.responseStream ? ' · server stream' : m.requestStream ? ' · client stream' : '');
    $('rtMethod').innerHTML = services
      .flatMap((s) => s.methods.map((m) => [`${s.name}/${m.name}`, kindOf(m)]))
      .map(([v, tag]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}${esc(tag)}</option>`)
      .join('');
    if (!cur && $('rtMethod').value) scheduleSave();
    $('rtHint').textContent = `${services.reduce((n, s) => n + s.methods.length, 0)} method ใน ${proto.split(/[\\/]/).at(-1)}`;
  } catch (err) {
    $('rtHint').textContent = err.message;
  }
}
const protoMethod = () => {
  const [service, method] = ($('rtMethod').value || '').split('/');
  return protoInfo.find((s) => s.name === service)?.methods.find((m) => m.name === method);
};

async function rtSend() {
  const file = state.req.file;
  const c = rtConn();
  const open = c && (c.status === 'open' || c.status === 'connecting');
  await saveNow();
  selectTab('body');
  try {
    if (open && c.canSend) {
      await api('/api/rt/send', { id: c.id, file, env: state.env.name, message: $('query').value, event: $('rtEvent').value.trim() || 'message', ack: $('rtAck').checked });
      return;
    }
    $('send').disabled = true;
    const r = await api('/api/rt/start', { file, env: state.env.name, auth: readAuth(), headers: readHeaders(), rt: readRt() });
    if (r.result) {
      // gRPC unary / client-streaming: one answer
      const res = r.result;
      state.rt[file] = { kind: state.req.kind, status: 'done', result: res, log: [{ t: Date.now(), dir: res.ok ? 'in' : 'sys', data: res.ok ? res.response : `${res.status}: ${res.error}`, error: !res.ok }] };
    } else rtFollow(file, r.id, state.req.kind, r.streaming);
  } catch (err) {
    state.rt[file] = { kind: state.req.kind, status: 'closed', log: [...(c?.log ?? []), { t: Date.now(), dir: 'sys', data: err.message, error: true }] };
  } finally {
    $('send').disabled = false;
    rtPaint();
    refreshToken();
  }
}

function rtFollow(file, id, kind, streaming) {
  state.rt[file]?.es?.close();
  const c = { id, kind, log: [], status: 'connecting', canSend: kind !== 'GrpcRequest' || !!streaming?.request };
  state.rt[file] = c;
  c.es = new EventSource(`/api/rt/events?id=${encodeURIComponent(id)}`);
  c.es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    c.log.push(e);
    if (e.state) c.status = e.state;
    if (e.state === 'closed') c.es.close();
    if (state.req?.file === file) rtPaint();
  };
  c.es.onerror = () => {
    c.es.close();
    if (c.status !== 'closed') {
      c.status = 'closed';
      c.log.push({ t: Date.now(), dir: 'sys', data: 'หลุดจาก Hyperion — กด Connect ใหม่', error: true });
    }
    if (state.req?.file === file) rtPaint();
  };
}

$('rtClose').onclick = async () => {
  const c = rtConn();
  if (!c?.id) return;
  await api('/api/rt/close', { id: c.id }).catch(() => {});
  if (c.status !== 'closed') {
    c.status = 'closed';
    c.log.push({ t: Date.now(), dir: 'sys', data: 'ปิดการเชื่อมต่อแล้ว' });
  }
  c.es?.close();
  rtPaint();
};

function rtLine(e) {
  const shown = (v) => ($('unmask').checked ? v : mask(v, state.req?.maskFields ?? DEFAULT_MASK));
  let body;
  if (typeof e.data === 'string') {
    try {
      const v = JSON.parse(e.data);
      body = v && typeof v === 'object' ? hlJSON(JSON.stringify(shown(v), null, 2)) : esc(e.data);
    } catch {
      body = esc(e.data);
    }
  } else body = hlJSON(JSON.stringify(shown(e.data), null, 2));
  const arrow = { in: '↓', out: '↑' }[e.dir] ?? '·';
  return `<li class="rt-${e.dir}${e.error ? ' err' : ''}"><span class="rt-dir" title="${e.dir === 'in' ? 'รับ' : e.dir === 'out' ? 'ส่ง' : 'สถานะ'}">${arrow}</span><time>${new Date(e.t).toLocaleTimeString()}</time>${e.event ? `<b class="rt-ev">${esc(e.event)}</b>` : ''}<pre>${body}</pre></li>`;
}

function rtPaint() {
  if (!isRt()) return;
  const c = rtConn();
  const grpc = state.req.kind === 'GrpcRequest';
  const open = c && (c.status === 'open' || c.status === 'connecting');
  $('send').innerHTML = `${open && c.canSend ? 'Send' : grpc ? 'Invoke' : 'Connect'} <kbd>Ctrl+Enter</kbd>`;
  $('send').disabled = !!open && !c.canSend; // a server stream is running: nothing to send
  $('rtClose').hidden = !open;
  $('rtClose').textContent = grpc ? 'หยุด stream' : 'Disconnect';
  const [cls, text] = !c
    ? ['', grpc ? 'ยังไม่ได้เรียก' : 'ยังไม่ได้เชื่อมต่อ']
    : c.result
      ? [c.result.ok ? 'ok' : 'err', c.result.status]
      : c.status === 'open'
        ? ['ok', grpc ? 'streaming' : 'เชื่อมต่ออยู่']
        : c.status === 'connecting'
          ? ['', 'กำลังเชื่อมต่อ…']
          : [c.log.some((e) => e.error) ? 'err' : '', 'ปิดแล้ว'];
  $('status').className = `status ${cls}`;
  $('status').textContent = text;
  $('resMeta').textContent = c?.result ? `${c.result.timeMs} ms` : c ? `${c.log.filter((e) => e.dir !== 'sys').length} ข้อความ` : '';
  const empty = grpc ? 'กด Invoke เพื่อเรียก method — stream จะแสดงทีละข้อความ' : 'กด Connect เพื่อเชื่อมต่อ แล้วกด Send เพื่อส่งข้อความในช่องด้านบน';
  $('tab-body').innerHTML = c ? `<ol class="rt-log">${c.log.map(rtLine).join('')}</ol>` : `<div class="empty">${empty}</div>`;
  $('tab-body').scrollTop = $('tab-body').scrollHeight;
}

$('rtBar').addEventListener('input', scheduleSave);
$('rtBar').addEventListener('change', scheduleSave);
$('rtProto').addEventListener('change', () => loadProto(true));
$('rtExample').onclick = () => {
  const m = protoMethod();
  if (!m) return ($('rtHint').textContent = 'เลือก method ก่อน');
  $('query').value = `${JSON.stringify(m.requestStream ? [m.example] : m.example, null, 2)}\n`;
  $('query').dispatchEvent(new Event('input'));
};

// ---------- send ----------
function currentOp() {
  const q = $('query').value;
  const m = q.match(/^\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\b\s*([A-Za-z_]\w*)?/);
  return { type: m?.[1] ?? 'query', name: state.req.operationName ?? m?.[2] ?? state.req.name };
}

async function send() {
  if (!state.req || $('send').disabled) return;
  if (isRt()) return rtSend();
  let variables;
  try {
    variables = JSON.parse($('vars').value || '{}');
  } catch {
    return validate();
  }
  const body = { file: state.req.file, env: state.env.name, variables, auth: readAuth(), headers: readHeaders() };
  if (state.req.kind !== 'HttpRequest') body.query = $('query').value;
  const op = currentOp();
  const writes = state.req.kind === 'HttpRequest' ? !['GET', 'HEAD', 'OPTIONS'].includes(state.req.method) : op.type === 'mutation';
  // a GraphQL mutation sent to prod (protected env) asks first: ตกลง / ยกเลิก. Other envs, queries and REST go straight out
  if (state.env.protected && state.req.kind !== 'HttpRequest' && op.type === 'mutation') {
    const ok = await askForm({
      title: `ยิง mutation ${op.name}?`,
      desc: `ไปที่ ${state.env.title ?? state.env.name} — ข้อมูลจริง · mutation จะเปลี่ยนข้อมูลในระบบ`,
      fields: [],
      submit: 'ตกลง',
      danger: true,
      onSubmit: async () => true,
    });
    if (!ok) return;
  }
  // the server's protected-env guard is for the CLI; in the app the dialog above is the check
  if (state.env.protected && writes) body.confirm = true;
  $('send').disabled = true;
  $('send').classList.add('busy');
  try {
    state.result = await api('/api/run', body);
    renderResult();
  } catch (err) {
    state.result = { error: err.message, tests: [], warnings: [], logs: [] };
    renderResult();
  } finally {
    $('send').disabled = false;
    $('send').classList.remove('busy');
    refreshToken();
  }
}

function renderResult() {
  const r = state.result;
  const ok = r.status != null && r.status < 400 && !r.error && !r.response?.json?.errors?.length;
  $('status').className = `status ${r.status == null ? 'err' : ok ? 'ok' : 'err'}`;
  $('status').textContent = r.blocked ? 'ถูกบล็อก' : r.status ?? 'ล้มเหลว';
  $('resMeta').textContent = [r.timeMs != null && `${r.timeMs} ms`, kb(r.size)].filter(Boolean).join(' · ');

  const banners = [];
  if (r.error) banners.push(`<div class="banner err">${esc(r.error)}</div>`);
  for (const w of r.warnings ?? []) banners.push(`<div class="banner warn">${esc(w)}</div>`);
  const resp = r.response;
  let bodyHtml = '';
  if (resp?.json !== undefined) {
    const shown = $('unmask').checked ? resp.json : mask(resp.json, state.view === 'flow' ? DEFAULT_MASK : state.req?.maskFields ?? DEFAULT_MASK);
    bodyHtml = `<pre>${hlJSON(JSON.stringify(shown, null, 2))}</pre>`;
  } else if (resp?.text) bodyHtml = `<pre>${esc(resp.text)}</pre>`;
  $('tab-body').innerHTML = banners.join('') + (bodyHtml || (banners.length ? '' : '<div class="empty">ไม่มี body</div>'));

  const tests = r.tests ?? [];
  const failed = tests.filter((t) => !t.pass).length;
  $('testCount').textContent = tests.length ? `${tests.length - failed}/${tests.length}` : '';
  $('testCount').className = failed ? 'fail' : '';
  $('tab-tests').innerHTML = tests.length
    ? `<ul class="tests">${tests.map((t) => `<li class="${t.pass ? 'pass' : 'fail'}">${esc(t.name)}${t.error ? `<small>${esc(t.error)}</small>` : ''}</li>`).join('')}</ul>`
    : '<div class="empty">request นี้ไม่มี test — เขียน $test(...) ใน afterResponse</div>';

  state.logs.push(...(r.logs ?? []).map((l) => `${new Date().toLocaleTimeString()}  ${l}`));
  renderLog();
  $('tab-headers').innerHTML = resp?.headers
    ? `<table class="kv">${Object.entries(resp.headers).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
    : '';
  if (failed && !r.error) selectTab('tests');
  else if (!resp && (r.logs ?? []).length && !r.error) selectTab('log');
  else selectTab('body');
}

function renderLog() {
  $('logCount').textContent = state.logs.length || '';
  $('tab-log').innerHTML = state.logs.length
    ? `<ul class="log">${state.logs.slice(-200).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<div class="empty">ยังไม่มี log — การ login / ต่ออายุ token / sync schema จะแสดงที่นี่</div>';
}

function selectTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const t of ['body', 'tests', 'log', 'headers']) $(`tab-${t}`).hidden = t !== name;
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => selectTab(b.dataset.tab);

// ---------- request tabs: Query / Authorization / Headers / Scripts ----------
function selectReqTab(name) {
  for (const b of document.querySelectorAll('[data-rtab]')) b.setAttribute('aria-selected', String(b.dataset.rtab === name));
  for (const t of ['query', 'auth', 'headers', 'scripts']) $(`rtab-${t}`).hidden = t !== name;
}
for (const b of document.querySelectorAll('[data-rtab]')) b.onclick = () => selectReqTab(b.dataset.rtab);

const AUTH_LABEL = { none: 'ไม่มี', bearer: 'Bearer Token', basic: 'Basic Auth', apiKey: 'API Key', tokenEndpoint: 'Login (ต่ออายุอัตโนมัติ)' };

function showAuthFields() {
  const t = $('authType').value;
  for (const el of document.querySelectorAll('[data-auth]')) el.hidden = el.dataset.auth !== t;
  $('authInherit').hidden = t !== 'inherit';
  $('authDot').hidden = t === 'inherit';
}

function fillAuth(auth, inherited) {
  const a = auth && typeof auth === 'object' ? auth : { type: auth === 'none' ? 'none' : 'inherit' };
  // a kind this tab cannot edit (e.g. a request-level login) stays exactly as it is in the file
  $('authType').querySelector('option[value=keep]')?.remove();
  if (!['inherit', 'none', 'bearer', 'basic', 'apiKey'].includes(a.type)) {
    $('authType').insertAdjacentHTML('beforeend', `<option value="keep">${esc(AUTH_LABEL[a.type] ?? a.type)} (ตั้งในไฟล์)</option>`);
  }
  $('authType').value = $('authType').querySelector(`option[value="${a.type}"]`) ? a.type : 'keep';
  $('bearerToken').value = a.bearer?.token ?? a.token ?? '';
  $('basicUser').value = a.basic?.username ?? '';
  $('basicPass').value = a.basic?.password ?? '';
  $('apiKeyName').value = a.apiKey?.name ?? '';
  $('apiKeyValue').value = a.apiKey?.value ?? '';
  $('apiKeyIn').value = a.apiKey?.in ?? 'header';
  $('authInherit').textContent = `ใช้ auth ของ collection: ${AUTH_LABEL[inherited] ?? inherited} — แก้ได้ที่ปุ่ม ตั้งค่า ของ collection`;
  showAuthFields();
  showBearerHint();
}

function readAuth() {
  const t = $('authType').value;
  if (t === 'inherit' || t === 'none') return t;
  if (t === 'keep') return state.req.auth;
  if (t === 'bearer') return { type: 'bearer', bearer: { token: $('bearerToken').value.trim() } };
  if (t === 'basic') return { type: 'basic', basic: { username: $('basicUser').value, password: $('basicPass').value } };
  return { type: 'apiKey', apiKey: { in: $('apiKeyIn').value, name: $('apiKeyName').value.trim(), value: $('apiKeyValue').value } };
}

function fillHeaders(headers, inherited) {
  const box = $('reqHeaders');
  for (const row of box.querySelectorAll('.kv-row')) row.remove();
  box.querySelector('.kv-add').insertAdjacentHTML('beforebegin', Object.entries(headers ?? {}).map(([k, v]) => kvRow(k, v)).join(''));
  const inh = Object.entries(inherited ?? {});
  $('inheritedHeaders').innerHTML = inh.length
    ? `<p class="hint">ส่งด้วยจาก collection (header ชื่อเดียวกันข้างบนจะทับ)</p>${inh.map(([k, v]) => `<div class="kv-row inherited"><input class="k" value="${esc(k)}" disabled><input class="v" value="${esc(v)}" disabled><span></span></div>`).join('')}`
    : '';
  $('headersDot').hidden = !Object.keys(headers ?? {}).length;
}

function readHeaders() {
  return Object.fromEntries(
    [...$('reqHeaders').querySelectorAll('.kv-row')].map((r) => [r.querySelector('.k').value.trim(), r.querySelector('.v').value]).filter(([k]) => k),
  );
}

$('authType').onchange = showAuthFields;

// a pasted token (not a {{variable}}) never goes into a file that is committed: it is stored for the current env in
// envs/<env>.local.env.yaml and the field becomes {{BEARER_TOKEN}}
const looksLikeToken = (v) => v.length >= 20 && !/\{\{/.test(v) && !/\s/.test(v);
async function stashToken(input, after) {
  const raw = input.value.trim().replace(/^Bearer\s+/i, '');
  if (!looksLikeToken(raw)) return false;
  const r = await api('/api/env/local', { env: state.env.name, name: 'BEARER_TOKEN', value: raw });
  input.value = '{{BEARER_TOKEN}}';
  after?.(`เก็บ token ของ ${state.env.title ?? state.env.name} ไว้ใน ${r.file} แล้ว (ไม่เข้า Git) · วาง token ใหม่ทับได้เลย`);
  return true;
}
async function showBearerHint() {
  if ($('bearerToken').value.trim() !== '{{BEARER_TOKEN}}' || !state.env) return;
  const r = await api(`/api/env/local?env=${encodeURIComponent(state.env.name)}&name=BEARER_TOKEN`).catch(() => null);
  $('bearerHint').textContent = r?.has
    ? `token ของ ${state.env.title ?? state.env.name}: ${r.preview} (เก็บใน envs/${state.env.name}.local.env.yaml) · วาง token ใหม่เพื่อเปลี่ยน`
    : `env ${state.env.title ?? state.env.name} ยังไม่มี token — วาง token ที่ช่องนี้`;
}
let tokenTimer;
$('bearerToken').addEventListener('focus', () => $('bearerToken').select());
$('bearerToken').addEventListener('input', () => {
  clearTimeout(tokenTimer);
  tokenTimer = setTimeout(async () => {
    try {
      if (await stashToken($('bearerToken'), (msg) => ($('bearerHint').textContent = msg))) {
        scheduleSave(); // the request file gets {{BEARER_TOKEN}}, not the token
        refreshToken().catch(() => {});
      }
    } catch (err) {
      $('bearerHint').textContent = `เก็บ token ไม่ได้: ${err.message}`;
    }
  }, 300);
});
$('reqHeaders').addEventListener('click', (e) => {
  if (e.target.closest('.kv-rm')) e.target.closest('.kv-row').remove();
  if (e.target.closest('.kv-add')) {
    e.target.closest('.kv-add').insertAdjacentHTML('beforebegin', kvRow());
    [...$('reqHeaders').querySelectorAll('.kv-row')].at(-1).querySelector('.k').focus();
  }
  $('headersDot').hidden = !Object.keys(readHeaders()).length;
});
$('reqHeaders').addEventListener('input', () => { $('headersDot').hidden = !Object.keys(readHeaders()).length; });
$('unmask').onchange = () => state.result && renderResult();

// ---------- buttons ----------
$('send').onclick = send;
// request autosave: query, variables, Authorization and Headers are written ~0.8 s after the last edit
let saveTimer;
function scheduleSave() {
  if (!state.req || state.view === 'flow') return;
  clearTimeout(saveTimer);
  $('save').textContent = 'ยังไม่บันทึก…';
  saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.req) return;
  let variables;
  try {
    variables = JSON.parse($('vars').value || '{}');
  } catch {
    $('save').textContent = 'Variables ไม่ใช่ JSON — ยังไม่บันทึก';
    return validate();
  }
  try {
    await api('/api/save', { file: state.req.file, query: isGql() ? $('query').value : undefined, variables: isRt() ? undefined : variables, rt: isRt() ? readRt() : undefined, auth: readAuth(), headers: readHeaders() });
    $('save').textContent = `บันทึกแล้ว ${new Date().toLocaleTimeString()}`;
    // token or headers changed while the schema is not this env's own: try this env's schema again
    const authKey = JSON.stringify([readAuth(), readHeaders()]);
    if (state.req.authKey !== undefined && authKey !== state.req.authKey && state.schema?.source !== 'target') autoSyncSchema(true);
    state.req.authKey = authKey;
  } catch (err) {
    $('save').textContent = `บันทึกไม่ได้: ${err.message}`;
  }
}
$('query').addEventListener('input', scheduleSave);
$('vars').addEventListener('input', scheduleSave);
$('rtab-auth').addEventListener('input', scheduleSave);
$('rtab-auth').addEventListener('change', scheduleSave);
$('reqHeaders').addEventListener('input', scheduleSave);
$('reqHeaders').addEventListener('click', (e) => e.target.closest('.kv-add, .kv-rm') && scheduleSave());
// schema loads by itself: when a request opens / the env changes and there is none yet (or it is old or borrowed),
// and again after the URL changes. Each collection + env is tried once per session unless forced.
const schemaTried = new Set();
let syncing = null;
async function autoSyncSchema(force = false) {
  if (!state.req || !isGql() || syncing) return syncing;
  const colDir = state.tree.requests.find((r) => r.file === state.req.file)?.collectionDir ?? state.req.file;
  const key = `${state.root}|${colDir}|${state.env.name}`;
  const m = state.schema;
  // a schema taken from another env because this one wanted a token counts as "not this env's yet"
  if (!force && ((m && !m.stale && !m.borrowed && !m.targetRejected) || schemaTried.has(key))) return;
  // the URL is still the template's <dev-host> or an unset {{VAR}}: nothing to fetch yet
  const url = state.req.resolvedUrl ?? '';
  if (!force && (!url || /<[^>]+>|\{\{/.test(url))) return;
  schemaTried.add(key);
  const b = $('sync');
  b.disabled = true;
  b.textContent = 'กำลังโหลด schema…';
  syncing = (async () => {
    try {
      // the Authorization / Headers tabs as they are now (a token typed there is used to read the schema too)
      const r = await api('/api/schema/sync', { file: state.req.file, env: state.env.name, auth: readAuth(), headers: readHeaders() });
      state.logs.push(...r.logs.map((l) => `${new Date().toLocaleTimeString()}  ${l}`));
      if (r.error) state.logs.push(`schema: ${r.error}`);
      renderLog();
      await refreshSchema();
      if (r.error && !state.schema) $('schemaStatus').innerHTML += ` <span class="drift">— โหลดไม่ได้ ดูแท็บ Log</span>`;
      await resetExplorer();
      validateSoon();
    } catch (err) {
      state.logs.push(`${new Date().toLocaleTimeString()}  schema: ${err.message}`);
      renderLog();
    } finally {
      b.disabled = false;
      b.textContent = 'sync ใหม่';
      syncing = null;
    }
  })();
  return syncing;
}
$('sync').onclick = () => autoSyncSchema(true);
const tokenAction = (action) => async () => {
  const r = await api('/api/token', { file: state.req.file, env: state.env.name, action });
  state.logs.push(...(r.logs ?? []).map((l) => `${new Date().toLocaleTimeString()}  ${l}`));
  if (r.error) state.logs.push(`✘ ${r.error}`);
  renderLog();
  if (r.error) selectTab('log');
  refreshToken();
};
$('tokenRefresh').onclick = tokenAction('refresh');
$('tokenClear').onclick = tokenAction('clear');
$('filter').oninput = renderSide;
$('newColBtn').onclick = newCollection;
$('move').onclick = moveCurrent;

// rename: click the request name in the header, type, Enter (Esc cancels); the file name stays the same
$('reqName').title = 'คลิกเพื่อเปลี่ยนชื่อ';
$('reqName').onclick = () => {
  const h = $('reqName');
  if (!state.req || h.isContentEditable) return;
  h.contentEditable = 'plaintext-only';
  h.focus();
  getSelection().selectAllChildren(h);
};
$('reqName').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('reqName').blur();
  } else if (e.key === 'Escape') {
    $('reqName').textContent = state.req?.name ?? '';
    $('reqName').blur();
  }
};
$('reqName').onblur = async () => {
  const h = $('reqName');
  h.contentEditable = 'false';
  h.scrollLeft = 0;
  const name = h.textContent.replace(/\s+/g, ' ').trim();
  if (!state.req || !name || name === state.req.name) {
    h.textContent = state.req?.name ?? '—';
    return;
  }
  try {
    await api('/api/save', { file: state.req.file, name });
    state.req.name = name;
    const t = state.tree.requests.find((r) => r.file === state.req.file);
    if (t) t.name = name;
    renderSide();
    $('save').textContent = `เปลี่ยนชื่อแล้ว ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    h.textContent = state.req.name;
    $('save').textContent = `เปลี่ยนชื่อไม่ได้: ${err.message}`;
  }
};

// delete asks once more in place: the first click arms the button, a second one within 6 s deletes
let delArmed = 0;
let delTimer;
const disarmDelete = () => {
  delArmed = 0;
  clearTimeout(delTimer);
  $('delReq').textContent = 'ลบ';
};
$('delReq').onclick = async () => {
  if (!state.req) return;
  if (!delArmed) {
    delArmed = Date.now();
    $('delReq').textContent = 'กดอีกครั้งเพื่อลบ';
    delTimer = setTimeout(disarmDelete, 6000);
    return;
  }
  disarmDelete();
  const file = state.req.file;
  clearTimeout(saveTimer); // a pending autosave must not write the file back
  const c = state.rt[file];
  if (c?.id) api('/api/rt/close', { id: c.id }).catch(() => {});
  c?.es?.close();
  delete state.rt[file];
  // open the next request of the same collection afterwards (else the one before, else any)
  const list = state.tree.requests;
  const i = list.findIndex((r) => r.file === file);
  const same = list.filter((r) => r.collectionDir === list[i]?.collectionDir && r.file !== file);
  const next = same.find((r) => list.indexOf(r) > i) ?? same.at(-1) ?? list.find((r) => r.file !== file);
  try {
    const r = await api('/api/request/delete', { file });
    state.logs.push(`${new Date().toLocaleTimeString()}  ลบ ${state.req.name} → ${r.trash}${r.flowsUsing.length ? ` · flow ที่ยังใช้ request นี้: ${r.flowsUsing.join(', ')}` : ''}`);
    renderLog();
    state.req = null;
    await loadTree(false);
    if (next) await openRequest(next.file);
  } catch (err) {
    alert(err.message);
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    state.view === 'flow' ? runCurrentFlow() : send();
  }
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (state.view !== 'flow') saveNow();
  }
});

// ---------- import ----------
$('importBtn').onclick = () => {
  $('importLog').innerHTML = '';
  // paste target: the collection of the open request, else the first one
  const current = state.tree.requests.find((r) => r.file === state.req?.file)?.collectionDir;
  $('pasteCollection').innerHTML = (state.tree.collections ?? []).map((c) => `<option value="${esc(c.dir)}"${c.dir === current ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $('importDlg').showModal();
};
// Postman desktop: list its collections (with how many GraphQL requests have their query), import the ticked ones
$('pmScan').onclick = async () => {
  const box = $('pmList');
  $('pmScan').disabled = true;
  box.innerHTML = '<p class="hint">กำลังอ่าน…</p>';
  try {
    const r = await api('/api/import/postman-desktop');
    if (!r.stores) {
      box.innerHTML = '<p class="hint">ไม่พบ Postman desktop ในเครื่องนี้</p>';
      return;
    }
    if (!r.collections.length) {
      box.innerHTML = '<p class="hint">ไม่พบ request แบบ GraphQL ใน Postman</p>';
      return;
    }
    box.innerHTML =
      r.collections
        .map(
          (c) => `<label class="check pm-col"><input type="checkbox" value="${esc(c.id)}"${c.requests ? ' checked' : ''}${c.requests ? '' : ' disabled'}>` +
            `<b>${esc(c.name)}</b> <small>${c.requests} request${c.namesOnly.length ? ` · อีก ${c.namesOnly.length} ตัวมีแต่ชื่อ` : ''}</small></label>` +
            (c.namesOnly.length
              ? `<details class="pm-names"><summary>ตัวที่มีแต่ชื่อ — เปิดใน Postman หนึ่งครั้งแล้วนำเข้าใหม่</summary><p>${c.namesOnly.map(esc).join(', ')}</p></details>`
              : ''),
        )
        .join('') + '<button type="button" class="primary" id="pmImport">นำเข้า collection ที่เลือก</button>';
    $('pmImport').onclick = async () => {
      const ids = [...box.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
      if (!ids.length) return;
      $('pmImport').disabled = true;
      $('pmImport').textContent = 'กำลังนำเข้า…';
      try {
        const res = await api('/api/import/postman-desktop', { ids, env: state.env?.name });
        const log = $('importLog');
        for (const c of res.report) {
          log.insertAdjacentHTML('beforeend', `<li>${esc(c.collection)} → ${esc(c.dir)}: ใหม่ ${c.created}, อัปเดต ${c.updated}</li>${c.notes.map((n) => `<li>  note: ${esc(n)}</li>`).join('')}`);
        }
        await loadTree(false);
      } catch (err) {
        $('importLog').insertAdjacentHTML('beforeend', `<li class="err">${esc(err.message)}</li>`);
      } finally {
        $('pmImport').disabled = false;
        $('pmImport').textContent = 'นำเข้า collection ที่เลือก';
      }
    };
  } catch (err) {
    box.innerHTML = `<p class="hint err">${esc(err.message)}</p>`;
  } finally {
    $('pmScan').disabled = false;
  }
};

$('pasteGo').onclick = async () => {
  const log = $('importLog');
  try {
    const r = await api('/api/import/paste', { text: $('pasteText').value, collection: $('pasteCollection').value, name: $('pasteName').value, env: state.env?.name });
    log.insertAdjacentHTML('beforeend', `<li>${esc(r.name)} (${r.kind === 'GraphQLRequest' ? 'GraphQL' : 'REST'}) → ${esc(r.file)}</li>${r.notes.map((n) => `<li>  note: ${esc(n)}</li>`).join('')}`);
    $('pasteText').value = '';
    $('pasteName').value = '';
    await loadTree(false);
    await openRequest(r.file);
  } catch (err) {
    log.insertAdjacentHTML('beforeend', `<li class="err">${esc(err.message)}</li>`);
  }
};
async function importFiles(files) {
  const log = $('importLog');
  for (const f of files) {
    try {
      const r = await api('/api/import', { name: f.name, json: JSON.parse(await f.text()) });
      log.insertAdjacentHTML('beforeend', `<li>${esc(f.name)}: ${esc(r.summary)}</li>${(r.notes ?? []).map((n) => `<li>  note: ${esc(n)}</li>`).join('')}`);
    } catch (err) {
      log.insertAdjacentHTML('beforeend', `<li>✘ ${esc(f.name)}: ${esc(err.message)}</li>`);
    }
  }
  await loadTree();
}
$('importFile').onchange = (e) => importFiles([...e.target.files]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  importFiles([...e.dataTransfer.files]);
};

renderLog();
loadTree().catch((err) => {
  $('tree').innerHTML = `<p class="banner err">${esc(err.message)}</p>`;
});
setInterval(() => state.req && refreshToken().catch(() => {}), 60000);

// ---------- app window lifecycle: the server stops once the last Hyperion window is closed ----------
const PAGE_ID = Math.random().toString(36).slice(2);
const ping = () => fetch(`/api/ping?p=${PAGE_ID}`).catch(() => {});
setInterval(ping, 10000);
ping();
addEventListener('pagehide', () => {
  try {
    fetch('/api/bye', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: PAGE_ID }) });
  } catch {}
});
addEventListener('pageshow', (e) => e.persisted && ping()); // back from the back/forward cache

// remember the window's size and position for next time (there is no move event: check now and then)
let lastBounds = '';
const reportBounds = () => {
  const max = screen.availWidth - outerWidth <= 8 && screen.availHeight - outerHeight <= 8;
  const b = { x: screenX, y: screenY, w: outerWidth, h: outerHeight, max };
  const key = JSON.stringify(b);
  if (key === lastBounds || document.hidden) return;
  lastBounds = key;
  fetch('/api/window', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: key }).catch(() => {});
};
let boundsTimer;
addEventListener('resize', () => {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(reportBounds, 500);
});
setInterval(reportBounds, 3000);
addEventListener('pagehide', reportBounds);
document.addEventListener('visibilitychange', () => !document.hidden && ping());

// ---------- schema explorer: tick fields to build the query (like Postman) ----------
const ex = { cache: new Map(), expanded: new Set(['query:']), selected: new Set(), args: {}, noSchema: false, key: '' };
const exKey = (op, path) => `${op}:${path.join('.')}`;

async function exFields(op, path) {
  const k = exKey(op, path);
  if (!ex.cache.has(k)) {
    const r = await api(`/api/explorer?file=${encodeURIComponent(state.req.file)}&env=${encodeURIComponent(state.env.name)}&op=${op}&path=${encodeURIComponent(path.join('.'))}`);
    ex.noSchema = !!r.noSchema;
    if (r.roots) ex.roots = r.roots;
    ex.cache.set(k, r.fields ?? []);
  }
  return ex.cache.get(k);
}

async function resetExplorer() {
  ex.cache.clear();
  ex.roots = null;
  const k = `${state.req?.file}|${state.env?.name}`;
  if (k !== ex.key) ex.expanded = new Set(['query:']); // a different request starts collapsed again
  ex.key = k;
  await updateSelected();
  await renderExplorer();
}

async function updateSelected() {
  if (!state.req || !isGql()) return;
  const r = await api('/api/explorer/selected', { query: $('query').value }).catch(() => ({ paths: [], args: {} }));
  ex.selected = new Set(r.paths);
  ex.args = r.args ?? {};
  for (const p of r.paths) {
    // keep ticked object fields open, so what is in the query is visible in the tree
    const [op, rest] = p.split(':');
    const parts = rest.split('.');
    for (let i = 1; i < parts.length; i++) ex.expanded.add(`${op}:${parts.slice(0, i).join('.')}`);
    ex.expanded.add(`${op}:`);
  }
}

async function renderExplorer() {
  const box = $('exTree');
  // REST requests have no schema; a collapsed panel keeps only its slim "Schema" bar
  $('explorer').hidden = !state.req || !isGql();
  const collapsed = store.get('explorer') === 'off';
  $('explorer').classList.toggle('collapsed', collapsed);
  const width = Number(store.get('exWidth'));
  if (width) $('explorer').style.setProperty('--ex-w', `${width}px`);
  if ($('explorer').hidden || collapsed) return;
  const roots = await exFields('query', []).catch(() => []);
  if (ex.noSchema) {
    box.innerHTML = '<p class="hint">ยังไม่มี schema — ใส่ URL ในแถบด้านบน แล้ว field จะขึ้นที่นี่เอง</p>';
    return;
  }
  const q = $('exSearch').value.trim().toLowerCase();
  const rows = [];
  let vars = {};
  try { vars = JSON.parse($('vars').value || '{}'); } catch {}
  const level = async (op, path, fields, depth) => {
    for (const f of fields) {
      if (depth === 0 && q && !f.name.toLowerCase().includes(q)) continue;
      const p = [...path, f.name];
      const k = exKey(op, p);
      const canOpen = !f.leaf || f.args.length > 0; // a field with arguments opens to show their inputs
      const open = canOpen && ex.expanded.has(k);
      const args = f.args.filter((a) => a.required).map((a) => a.name).join(', ');
      rows.push(
        `<div class="ex-row${f.deprecated ? ' deprecated' : ''}" style="--d:${depth}" data-op="${op}" data-path="${esc(p.join('.'))}" title="${esc(f.description || f.type)}">` +
          (canOpen ? `<button class="ex-chev" aria-expanded="${open}" aria-label="เปิด ${esc(f.name)}"></button>` : '<span class="ex-chev"></span>') +
          `<label><input type="checkbox"${ex.selected.has(k) ? ' checked' : ''}><span class="ex-name">${esc(f.name)}</span>${args ? `<span class="ex-args">(${esc(args)})</span>` : ''}</label>` +
          `<small>${esc(f.type)}</small>` +
          '</div>',
      );
      if (!open) continue;
      // argument inputs: what is typed goes into Variables
      const used = ex.args[k] ?? {};
      for (const a of f.args) {
        const u = used[a.name];
        const value = u?.var !== undefined ? vars[u.var] : u?.value;
        const shown = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
        rows.push(
          `<div class="ex-arg" style="--d:${depth + 1}" data-op="${op}" data-path="${esc(p.join('.'))}" data-arg="${esc(a.name)}" data-type="${esc(a.type)}">` +
            `<input type="checkbox" class="ex-argon"${u ? ' checked' : ''}${a.required ? ' disabled title="ต้องมี"' : ''} aria-label="ส่ง ${esc(a.name)}">` +
            `<span class="ex-argname">${esc(a.name)}:</span>` +
            `<input class="ex-val" value="${esc(shown)}" placeholder="${esc(a.type)}" spellcheck="false" autocomplete="off"${u && u.var === undefined ? ' disabled title="ค่าเขียนตรงใน query"' : ''}>` +
            `<small>${u?.var ? `$${esc(u.var)}` : ''}</small></div>`,
        );
      }
      if (!f.leaf) {
        const children = await exFields(op, p);
        // first row: tick / untick every plain field below (objects inside have their own row)
        const leaves = children.filter((c) => c.leaf && !c.args.some((a) => a.required));
        const on = leaves.filter((c) => ex.selected.has(exKey(op, [...p, c.name]))).length;
        if (leaves.length) {
          rows.push(
            `<div class="ex-allrow" style="--d:${depth + 1}" data-op="${op}" data-path="${esc(p.join('.'))}">` +
              `<label><input type="checkbox" class="ex-all"${on === leaves.length ? ' checked' : ''}${on > 0 && on < leaves.length ? ' data-partial' : ''}>` +
              `ทุก field <small>(${on}/${leaves.length})</small></label></div>`,
          );
        }
        await level(op, p, children, depth + 1);
      }
    }
  };
  for (const op of ['query', 'mutation']) {
    if (op === 'mutation' && !ex.roots?.mutation) continue;
    const open = ex.expanded.has(`${op}:`);
    rows.push(`<button class="ex-section" data-op="${op}" aria-expanded="${open}">${op === 'query' ? 'Query' : 'Mutation'}</button>`);
    if (open) await level(op, [], op === 'query' ? roots : await exFields(op, []), 0);
  }
  // redraws must not steal the cursor from an argument box the user is typing in
  const active = document.activeElement?.closest?.('.ex-arg');
  const caret = active && document.activeElement.selectionStart;
  box.innerHTML = rows.join('');
  for (const partial of box.querySelectorAll('.ex-all[data-partial]')) partial.indeterminate = true;
  if (active) {
    const again = box.querySelector(`.ex-arg[data-path="${CSS.escape(active.dataset.path)}"][data-arg="${CSS.escape(active.dataset.arg)}"] .ex-val`);
    again?.focus();
    if (again && caret != null) again.setSelectionRange(caret, caret);
  }
}

$('exTree').addEventListener('click', async (e) => {
  const sec = e.target.closest('.ex-section');
  const chev = e.target.closest('button.ex-chev');
  if (sec || chev) {
    const k = sec ? `${sec.dataset.op}:` : exKey(chev.closest('.ex-row').dataset.op, chev.closest('.ex-row').dataset.path.split('.'));
    ex.expanded.has(k) ? ex.expanded.delete(k) : ex.expanded.add(k);
    return renderExplorer();
  }
});

/** Put a builder result into the editor: query, Variables (added / removed / set), ticks and arguments. */
async function applyBuild(r, { expand, setVar } = {}) {
  $('query').value = r.query;
  paintQuery();
  let vars = {};
  try { vars = JSON.parse($('vars').value || '{}'); } catch { vars = null; }
  if (vars) {
    for (const [k, v] of Object.entries(r.added ?? {})) if (!(k in vars)) vars[k] = v;
    for (const k of r.removed ?? []) delete vars[k];
    if (setVar) vars[setVar.name] = setVar.value;
    $('vars').value = JSON.stringify(vars, null, 2);
    paintVars();
  }
  ex.selected = new Set(r.selected ?? r.paths ?? []);
  ex.args = r.args ?? (await api('/api/explorer/selected', { query: r.query }).catch(() => ({ args: {} }))).args ?? {};
  if (expand) ex.expanded.add(expand);
  scheduleSave();
  validateSoon();
  await renderExplorer();
}

function explorerError(err) {
  state.logs.push(`${new Date().toLocaleTimeString()}  explorer: ${err.message}`);
  renderLog();
  $('lint').innerHTML = `<li>${esc(err.message)}</li>`;
}

/** Typed text → the value Variables should hold for this GraphQL type. */
function typedValue(text, type) {
  const t = type.replace(/!/g, '');
  if (text === '') return '';
  if (t.startsWith('[') || t === 'JSON') {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (/^(Int|Float|Long|Short|BigDecimal|BigInteger)$/.test(t) && text.trim() !== '' && !Number.isNaN(Number(text))) return Number(text);
  if (t === 'Boolean' && /^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === 'true';
  return text;
}

const exCall = (url, body) => api(url, { file: state.req.file, env: state.env.name, query: $('query').value, ...body });

$('exTree').addEventListener('change', async (e) => {
  // a field's checkbox
  const box = e.target.closest('.ex-row input[type=checkbox]');
  if (box) {
    const row = box.closest('.ex-row');
    const path = row.dataset.path.split('.');
    try {
      const r = await exCall('/api/explorer/toggle', { op: row.dataset.op, path, on: box.checked });
      await applyBuild(r, { expand: box.checked ? exKey(row.dataset.op, path) : null });
    } catch (err) {
      box.checked = !box.checked;
      explorerError(err);
    }
    return;
  }
  // an optional argument's checkbox
  const argBox = e.target.closest('.ex-argon');
  if (argBox) {
    const row = argBox.closest('.ex-arg');
    try {
      const r = await exCall('/api/explorer/arg', { op: row.dataset.op, path: row.dataset.path.split('.'), arg: row.dataset.arg, on: argBox.checked });
      await applyBuild(r);
    } catch (err) {
      argBox.checked = !argBox.checked;
      explorerError(err);
    }
  }
});

// typing an argument value: pass the argument (if it is not yet) and put the value in Variables
let exValTimer;
$('exTree').addEventListener('input', (e) => {
  const input = e.target.closest('.ex-val');
  if (!input) return;
  clearTimeout(exValTimer);
  exValTimer = setTimeout(async () => {
    const row = input.closest('.ex-arg');
    const k = exKey(row.dataset.op, row.dataset.path.split('.'));
    const value = typedValue(input.value, row.dataset.type);
    const current = ex.args[k]?.[row.dataset.arg]?.var;
    try {
      if (current) {
        // already a variable: only Variables changes — keep typing focus, no re-render
        let vars = {};
        try { vars = JSON.parse($('vars').value || '{}'); } catch { return; }
        vars[current] = value;
        $('vars').value = JSON.stringify(vars, null, 2);
        paintVars();
        scheduleSave();
        return;
      }
      const r = await exCall('/api/explorer/arg', { op: row.dataset.op, path: row.dataset.path.split('.'), arg: row.dataset.arg, on: true });
      await applyBuild(r, { setVar: r.varName ? { name: r.varName, value } : null });
      // the panel was redrawn: put the cursor back in the same box
      const again = $('exTree').querySelector(`.ex-arg[data-path="${CSS.escape(row.dataset.path)}"][data-arg="${CSS.escape(row.dataset.arg)}"] .ex-val`);
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    } catch (err) {
      explorerError(err);
    }
  }, 400);
});

// "ทุก field": tick every plain field under an object (partly ticked → tick the rest), or untick them all
$('exTree').addEventListener('change', async (e) => {
  const box = e.target.closest('.ex-all');
  if (!box) return;
  const row = box.closest('.ex-allrow');
  const op = row.dataset.op;
  const path = row.dataset.path.split('.');
  try {
    const r = await exCall('/api/explorer/toggle-all', { op, path, on: box.checked });
    await applyBuild(r, { expand: exKey(op, path) });
  } catch (err) {
    box.checked = !box.checked;
    explorerError(err);
  }
});

let exSearchTimer;
$('exSearch').addEventListener('input', () => {
  clearTimeout(exSearchTimer);
  exSearchTimer = setTimeout(renderExplorer, 120);
});
// collapse to a slim bar / expand again
$('exCollapse').onclick = () => {
  store.set('explorer', 'off');
  renderExplorer();
};
$('exExpand').onclick = () => {
  store.set('explorer', 'on');
  renderExplorer();
};
// drag the right edge to resize (remembered)
$('exResize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const panel = $('explorer');
  const startX = e.clientX;
  const startW = panel.getBoundingClientRect().width;
  $('exResize').setPointerCapture(e.pointerId);
  const move = (ev) => {
    const w = Math.min(Math.max(startW + ev.clientX - startX, 180), 600);
    panel.style.setProperty('--ex-w', `${w}px`);
    store.set('exWidth', String(Math.round(w)));
  };
  const up = () => {
    $('exResize').removeEventListener('pointermove', move);
    $('exResize').removeEventListener('pointerup', up);
  };
  $('exResize').addEventListener('pointermove', move);
  $('exResize').addEventListener('pointerup', up);
});
$('exResize').addEventListener('dblclick', () => {
  $('explorer').style.removeProperty('--ex-w');
  store.set('exWidth', '');
});

// drag a handle; onMove gets how far the pointer went (dx, dy) since the press
function dragHandle(handle, onStart, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const start = onStart();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(start, ev.clientX - e.clientX, ev.clientY - e.clientY);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// request ↔ response: the request pane's right edge; kept as a ratio so it fits any window width
const work = document.querySelector('.work');
if (store.get('edRatio')) work.style.setProperty('--ed-fr', `${store.get('edRatio')}fr`);
dragHandle(
  $('paneResize'),
  () => ({ ed: document.querySelector('.editor').getBoundingClientRect().width, res: document.querySelector('.result').getBoundingClientRect().width }),
  (s, dx) => {
    const ed = Math.min(Math.max(s.ed + dx, 320), s.ed + s.res - 280);
    const ratio = (ed / (s.ed + s.res - ed)).toFixed(3);
    work.style.setProperty('--ed-fr', `${ratio}fr`);
    store.set('edRatio', ratio);
  },
);
$('paneResize').addEventListener('dblclick', () => {
  work.style.removeProperty('--ed-fr');
  store.set('edRatio', '');
});

// Query ↔ Variables: drag the Variables bar up / down; ย่อ folds Variables away
const qMain = document.querySelector('.q-main');
if (store.get('varsH')) qMain.style.setProperty('--vars-h', `${store.get('varsH')}px`);
const setVarsFolded = (folded) => {
  document.body.classList.toggle('vars-folded', folded);
  $('varsFold').textContent = folded ? 'ขยาย' : 'ย่อ';
  store.set('varsFolded', folded ? '1' : '');
};
setVarsFolded(store.get('varsFolded') === '1');
$('varsFold').onclick = () => setVarsFolded(!document.body.classList.contains('vars-folded'));
dragHandle(
  $('varsHead'),
  () => {
    if (document.body.classList.contains('vars-folded')) setVarsFolded(false);
    return { h: document.querySelector('.vars-wrap').getBoundingClientRect().height, max: qMain.getBoundingClientRect().height - 140 };
  },
  (s, dx, dy) => {
    const h = Math.round(Math.min(Math.max(s.h - dy, 40), Math.max(s.max, 60)));
    qMain.style.setProperty('--vars-h', `${h}px`);
    store.set('varsH', String(h));
  },
);
$('varsHead').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  qMain.style.removeProperty('--vars-h');
  store.set('varsH', '');
});

// ---------- flows: blocks that run requests in order (like Postman Flows) ----------
function renderFlowList(q = '') {
  const flows = (state.tree.flows ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const g = document.createElement('div');
  g.className = 'group flows-group';
  g.innerHTML = `<div class="group-head"><h3>Flows</h3><button class="icon-btn flow-new" title="สร้าง flow ใหม่">+ Flow</button></div>` +
    (flows.length ? '' : '<p class="group-empty">ยังไม่มี flow — <button>สร้าง flow แรก</button></p>');
  for (const f of flows) {
    const b = document.createElement('button');
    b.className = 'req';
    b.dataset.flow = f.file;
    b.innerHTML = `<span class="op flow">flow</span><span>${esc(f.name)}</span>`;
    b.onclick = () => openFlow(f.file);
    if (state.view === 'flow' && state.flowFile === f.file) b.setAttribute('aria-current', 'true');
    g.append(b);
  }
  g.querySelector('.flow-new').onclick = newFlow;
  g.querySelector('.group-empty button')?.addEventListener('click', newFlow);
  $('tree').append(g);
}

async function newFlow() {
  const made = await askForm({
    title: 'Flow ใหม่',
    desc: 'flow รัน request จากทุก collection ตามลำดับ ส่งค่าต่อกันด้วย $flow.set / pm.environment.set',
    fields: [{ name: 'name', label: 'ชื่อ flow', value: 'My Flow', required: true }],
    submit: 'สร้าง flow',
    onSubmit: (v) => api('/api/flow/new', v),
  });
  if (!made) return;
  state.view = 'flow';
  state.flowFile = made.file;
  await loadTree(false);
}

async function openFlow(file) {
  const f = await api(`/api/flow?file=${encodeURIComponent(file)}`);
  state.view = 'flow';
  state.flowFile = file;
  state.flow = f;
  state.flowRun = null;
  state.flowPick = null;
  document.body.classList.add('flow-mode');
  for (const b of document.querySelectorAll('.req')) b.toggleAttribute('aria-current', b.dataset.flow === file);
  for (const b of document.querySelectorAll('.req[aria-current]')) b.setAttribute('aria-current', 'true');
  $('flowName').textContent = f.name;
  renderFlow();
}

function flowStatus(i) {
  const run = state.flowRun;
  const r = run?.results.find((x) => x.index === i);
  if (!r) return run && run.stoppedAt != null && i > run.stoppedAt ? '<span class="fstat idle">ไม่ได้รัน</span>' : '';
  if (r.skipped) return '<span class="fstat idle">ข้าม (เงื่อนไขไม่ผ่าน)</span>';
  if (r.blocked) return '<span class="fstat fail">ถูกกัน (env protected)</span>';
  const tests = r.tests?.length ? ` · tests ${r.tests.filter((t) => t.pass).length}/${r.tests.length}` : '';
  return `<span class="fstat ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'} ${r.status ?? ''}${r.timeMs != null ? ` · ${r.timeMs} ms` : ''}${tests}</span>`;
}

function renderFlow() {
  const f = state.flow;
  const opLabel = (op) => (op === 'mutation' ? 'mut' : op === 'query' ? 'qry' : op ?? '?');
  const blocks = f.steps
    .map((s, i) => `
    <div class="fnode${s.missing ? ' missing' : ''}${state.flowPick === i ? ' picked' : ''}" data-i="${i}">
      <button class="fnode-head" title="ดูผลของ block นี้">
        <span class="fnum">${i + 1}</span>
        <span class="op ${esc(s.op ?? '')}">${esc(opLabel(s.op))}</span>
        <span class="fname">${esc(s.name)}</span>
        <small>${esc(s.missing ? `ไม่พบ ${s.request}` : s.collection)}</small>
        ${flowStatus(i)}
      </button>
      <div class="fnode-body">
        <label class="fwhen">เงื่อนไข<input value="${esc(s.when ?? '')}" placeholder="ไม่บังคับ เช่น $flow.get('visitId')" spellcheck="false"></label>
        <label class="check"><input type="checkbox" class="fcont"${s.continueOnFail ? ' checked' : ''}> ไปต่อแม้ไม่ผ่าน</label>
        <span class="fnode-actions">
          <button class="icon-btn" data-act="up" title="เลื่อนขึ้น"${i === 0 ? ' disabled' : ''}>ขึ้น</button>
          <button class="icon-btn" data-act="down" title="เลื่อนลง"${i === f.steps.length - 1 ? ' disabled' : ''}>ลง</button>
          <button class="icon-btn" data-act="open" title="เปิด request นี้"${s.missing ? ' disabled' : ''}>เปิด</button>
          <button class="icon-btn" data-act="rm" title="เอา block นี้ออก">ลบ</button>
        </span>
      </div>
    </div>`)
    .join('');
  const run = state.flowRun;
  const summary = run
    ? `<p class="frun-sum ${run.passed ? 'pass' : 'fail'}">${run.passed ? 'flow ผ่านทั้งหมด' : `flow หยุดที่ block ${(run.stoppedAt ?? Math.max(run.results.length - 1, 0)) + 1}`}</p>`
    : '';
  $('flowCanvas').innerHTML = `<div class="fstart">Start</div>${blocks}<button class="fadd" id="flowAddInline">+ Block</button>${summary}`;
  $('flowAddInline').onclick = addFlowBlock;
}

let flowSaveTimer;
function saveFlowSoon() {
  clearTimeout(flowSaveTimer);
  flowSaveTimer = setTimeout(() => api('/api/flow/save', { file: state.flowFile, steps: state.flow.steps }).catch((err) => alert(err.message)), 500);
}

async function addFlowBlock() {
  const reqs = state.tree.requests;
  if (!reqs.length) return alert('ยังไม่มี request ในโปรเจกต์');
  const picked = await askForm({
    title: 'เพิ่ม block',
    desc: 'เลือก request ที่จะรันใน flow (จาก collection ไหนก็ได้)',
    fields: [{ name: 'request', label: 'Request', type: 'select', options: reqs.map((r) => ({ value: r.file, label: `${r.collection} / ${r.name}` })) }],
    submit: 'เพิ่ม',
    onSubmit: async (v) => v,
  });
  if (!picked) return;
  state.flow.steps.push({ request: picked.request });
  await api('/api/flow/save', { file: state.flowFile, steps: state.flow.steps });
  await loadTree(false);
}

$('flowAdd').onclick = addFlowBlock;
$('flowCanvas').addEventListener('click', async (e) => {
  const node = e.target.closest('.fnode');
  if (!node) return;
  const i = Number(node.dataset.i);
  const steps = state.flow.steps;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    state.flowRun = null;
    saveFlowSoon();
    return renderFlow();
  }
  if (act === 'rm') {
    steps.splice(i, 1);
    state.flowRun = null;
    saveFlowSoon();
    return renderFlow();
  }
  if (act === 'open') return openRequest(steps[i].request);
  if (e.target.closest('.fnode-head')) {
    // show this block's response in the result pane
    state.flowPick = i;
    const r = state.flowRun?.results.find((x) => x.index === i);
    if (r) {
      state.result = r;
      renderResult();
    }
    renderFlow();
  }
});
$('flowCanvas').addEventListener('input', (e) => {
  const node = e.target.closest('.fnode');
  if (!node) return;
  const s = state.flow.steps[Number(node.dataset.i)];
  if (e.target.closest('.fwhen')) s.when = e.target.value;
  if (e.target.classList.contains('fcont')) s.continueOnFail = e.target.checked;
  saveFlowSoon();
});

async function runCurrentFlow() {
  if (!state.flowFile || $('flowRun').disabled) return;
  clearTimeout(flowSaveTimer);
  await api('/api/flow/save', { file: state.flowFile, steps: state.flow.steps });
  $('flowRun').disabled = true;
  $('flowRun').classList.add('busy');
  try {
    const r = await api('/api/flow/run', { file: state.flowFile, env: state.env.name });
    state.flowRun = r;
    state.logs.push(...(r.logs ?? []).map((l) => `${new Date().toLocaleTimeString()}  ${l}`));
    renderLog();
    // show the block that failed, otherwise the last one that ran
    const show = r.results.find((x) => !x.passed && !x.skipped) ?? r.results.filter((x) => !x.skipped).at(-1);
    state.flowPick = show?.index;
    if (show) {
      state.result = show;
      renderResult();
    }
  } catch (err) {
    state.flowRun = { results: [], passed: false, stoppedAt: 0 };
    state.logs.push(`${new Date().toLocaleTimeString()}  flow: ${err.message}`);
    renderLog();
    selectTab('log');
  } finally {
    $('flowRun').disabled = false;
    $('flowRun').classList.remove('busy');
    renderFlow();
    refreshToken().catch(() => {});
  }
}
$('flowRun').onclick = runCurrentFlow;
$('flowDelete').onclick = async () => {
  if (!confirm(`ลบ flow "${state.flow.name}"? (ลบไฟล์ ${state.flowFile})`)) return;
  await api('/api/flow/delete', { file: state.flowFile });
  state.view = 'request';
  state.flowFile = null;
  document.body.classList.remove('flow-mode');
  await loadTree(true);
};
