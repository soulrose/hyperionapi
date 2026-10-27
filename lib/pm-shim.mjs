// `pm.*` compatibility for scripts imported from Postman: maps onto $env/$flow/$test/$http/$req/$res
// and implements the chai `expect` subset Postman collections commonly use.
import { inspect } from 'node:util';

const show = (v) => inspect(v, { depth: 3, breakLength: Infinity });

/** Structural equality that also works for objects created inside the vm context (different prototypes). */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function includes(hay, needle) {
  if (typeof hay === 'string') return hay.includes(needle);
  if (Array.isArray(hay)) return hay.some((x) => deepEqual(x, needle));
  if (hay && typeof hay === 'object' && needle && typeof needle === 'object') {
    return Object.entries(needle).every(([k, v]) => deepEqual(hay[k], v));
  }
  return false;
}

export function chaiExpect(actual) {
  const flags = { negate: false, deep: false };
  const chain = {};
  const assert = (pass, msg) => {
    if (pass === flags.negate) throw new Error(`expected ${show(actual)} ${flags.negate ? 'not ' : ''}${msg}`);
    return chain;
  };
  for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still', 'also']) {
    Object.defineProperty(chain, w, { get: () => chain });
  }
  Object.defineProperty(chain, 'not', { get: () => ((flags.negate = !flags.negate), chain) });
  Object.defineProperty(chain, 'deep', { get: () => ((flags.deep = true), chain) });
  const getters = {
    ok: () => assert(!!actual, 'to be ok'),
    true: () => assert(actual === true, 'to be true'),
    false: () => assert(actual === false, 'to be false'),
    null: () => assert(actual === null, 'to be null'),
    undefined: () => assert(actual === undefined, 'to be undefined'),
    exist: () => assert(actual != null, 'to exist'),
    empty: () => assert(actual != null && (typeof actual === 'object' ? Object.keys(actual).length === 0 : actual.length === 0), 'to be empty'),
  };
  for (const [k, f] of Object.entries(getters)) Object.defineProperty(chain, k, { get: f });
  const eq = (e) => assert(flags.deep ? deepEqual(actual, e) : Object.is(actual, e), `to ${flags.deep ? 'deeply ' : ''}equal ${show(e)}`);
  const len = (n) => assert(actual?.length === n, `to have length ${n}`);
  Object.assign(chain, {
    equal: eq,
    equals: eq,
    eq,
    eql: (e) => assert(deepEqual(actual, e), `to eql ${show(e)}`),
    above: (n) => assert(actual > n, `to be above ${n}`),
    gt: (n) => assert(actual > n, `to be above ${n}`),
    below: (n) => assert(actual < n, `to be below ${n}`),
    lt: (n) => assert(actual < n, `to be below ${n}`),
    least: (n) => assert(actual >= n, `to be at least ${n}`),
    gte: (n) => assert(actual >= n, `to be at least ${n}`),
    most: (n) => assert(actual <= n, `to be at most ${n}`),
    lte: (n) => assert(actual <= n, `to be at most ${n}`),
    within: (a, b) => assert(actual >= a && actual <= b, `to be within ${a}..${b}`),
    a: (t) => assert(typeOf(actual) === String(t).toLowerCase(), `to be a ${t}`),
    an: (t) => assert(typeOf(actual) === String(t).toLowerCase(), `to be an ${t}`),
    include: (e) => assert(includes(actual, e), `to include ${show(e)}`),
    includes: (e) => assert(includes(actual, e), `to include ${show(e)}`),
    contain: (e) => assert(includes(actual, e), `to contain ${show(e)}`),
    contains: (e) => assert(includes(actual, e), `to contain ${show(e)}`),
    oneOf: (list) => assert(list.some((x) => deepEqual(x, actual)), `to be one of ${show(list)}`),
    match: (re) => assert(new RegExp(re).test(String(actual)), `to match ${re}`),
    lengthOf: len,
    length: len,
    keys: (...ks) => assert(ks.flat().every((k) => actual != null && k in Object(actual)), `to have keys ${show(ks.flat())}`),
    property: (k, ...v) => {
      const has = actual != null && k in Object(actual);
      if (v.length) assert(has && deepEqual(actual[k], v[0]), `to have property ${show(k)} = ${show(v[0])}`);
      else assert(has, `to have property ${show(k)}`);
      // like chai: the property value becomes the subject of the rest of the chain
      return flags.negate ? chain : chaiExpect(actual[k]);
    },
  });
  return chain;
}

function responseApi(res) {
  if (!res) return undefined;
  const lower = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const fail = (msg) => {
    throw new Error(msg);
  };
  const status = (code) => (res.status === code ? undefined : fail(`expected response to have status ${code} but got ${res.status}`));
  return {
    code: res.status,
    status: String(res.status),
    responseTime: res.timeMs,
    json: () => (res.json === undefined ? fail('response is not JSON') : res.json),
    text: () => res.text,
    headers: { get: (k) => lower[String(k).toLowerCase()], has: (k) => String(k).toLowerCase() in lower },
    to: {
      have: {
        status,
        header: (k) => (String(k).toLowerCase() in lower ? undefined : fail(`expected header ${k}`)),
        jsonBody: () => (res.json === undefined ? fail('expected a JSON body') : undefined),
      },
      be: {
        get ok() { return res.status >= 200 && res.status < 300 ? undefined : fail(`expected 2xx but got ${res.status}`); },
        get success() { return this.ok; },
        get json() { return res.json === undefined ? fail('expected a JSON body') : undefined; },
      },
    },
  };
}

export function createPm(api, pending) {
  const vars = { get: (k) => api.$env.get(k), set: (k, v) => api.$env.set(k, v), unset: (k) => api.$env.set(k, undefined), has: (k) => api.$env.get(k) !== undefined };
  const sendRequest = (input, cb) => {
    const r = typeof input === 'string' ? { url: input } : input;
    const headers = Array.isArray(r.header) ? Object.fromEntries(r.header.map((h) => [h.key, h.value])) : r.header ?? {};
    const body = r.body?.mode === 'raw' ? r.body.raw : r.body?.mode === 'urlencoded' ? new URLSearchParams(r.body.urlencoded.map((p) => [p.key, p.value])).toString() : undefined;
    const method = (r.method ?? 'GET').toLowerCase();
    const p = api.$http[method](typeof r.url === 'string' ? r.url : r.url?.raw, { headers, body }).then(
      (res) => {
        const out = responseApi(res);
        cb?.(null, out);
        return out;
      },
      (err) => {
        if (cb) cb(err);
        else throw err;
      },
    );
    pending.push(p);
    return p;
  };
  const req = api.$req;
  const pm = {
    environment: vars,
    variables: vars,
    collectionVariables: vars,
    globals: vars,
    iterationData: { get: (k) => api.$env.get(k) },
    test: (name, fn) => api.$test(name, fn),
    expect: chaiExpect,
    response: responseApi(api.$res),
    request: req && {
      get url() { return req.url; },
      headers: {
        get: (k) => req.headers.get(k),
        add: (h) => req.headers.set(h.key, h.value),
        upsert: (h) => req.headers.set(h.key, h.value),
        remove: (k) => req.headers.delete(k),
      },
    },
    sendRequest,
  };
  const postman = {
    setEnvironmentVariable: vars.set,
    getEnvironmentVariable: vars.get,
    setGlobalVariable: vars.set,
    getGlobalVariable: vars.get,
  };
  return { pm, postman };
}
