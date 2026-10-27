// Small shared helpers — no dependencies.

/** Read a dotted/bracket path such as "data.items[0].id". */
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Return the `exp` claim of a JWT as epoch ms, or null when the token is not a JWT. */
export function jwtExpiryMs(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

/** Case-insensitive header lookup; returns the existing key or undefined. */
export function findHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

export function setHeader(headers, name, value) {
  const existing = findHeader(headers, name);
  if (existing && existing !== name) delete headers[existing];
  headers[name] = value;
}

/** Mask string values under keys listed in `fields` (PHI). Returns a new value. */
export function maskDeep(value, fields) {
  if (!fields?.length) return value;
  const set = new Set(fields.map((f) => f.toLowerCase()));
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = set.has(k.toLowerCase()) && val != null && typeof val !== 'object' ? maskValue(val) : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

function maskValue(val) {
  const chars = [...String(val)];
  return chars.map((c, i) => (i === 0 || c === ' ' ? c : '●')).join('');
}

export function maskToken(t) {
  const s = String(t ?? '');
  return s.length <= 10 ? '●●●' : `${s.slice(0, 6)}…${s.slice(-4)}`;
}
