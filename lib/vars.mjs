// Variable scopes (low → high): global < collection < env < env.local < data < flow < runtime.
// Templates: {{NAME}}, {{secret:NAME}}, {{$today}}, {{$isoNow}}, {{$timestamp}}, {{$uuid}}, {{$randomInt}}.
import { randomUUID } from 'node:crypto';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export function createVars({ global = {}, collection = {}, env, data = {}, flow = {}, runtime = {}, secrets }) {
  const layers = () => [runtime, flow, data, env?.localVariables ?? {}, env?.variables ?? {}, collection, global];
  const scopeNames = ['runtime', 'flow', 'data', 'env.local', 'env', 'collection', 'global'];
  return {
    runtime,
    flow,
    get(name) {
      for (const layer of layers()) if (Object.hasOwn(layer, name)) return layer[name];
      return undefined;
    },
    /** Which scope a variable resolves from (for debugging). */
    whereIs(name) {
      const i = layers().findIndex((l) => Object.hasOwn(l, name));
      return i < 0 ? null : scopeNames[i];
    },
    secret(name) {
      return secrets?.get(name);
    },
  };
}

function dynamic(name) {
  const now = new Date();
  switch (name) {
    case '$today': {
      const p = (n) => String(n).padStart(2, '0');
      return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    }
    case '$isoNow':
      return now.toISOString();
    case '$timestamp':
      return String(now.getTime());
    case '$uuid':
    case '$guid':
      return randomUUID();
    case '$randomInt':
      return Math.floor(Math.random() * 1000);
    default:
      return undefined;
  }
}

function lookup(name, vars) {
  if (name.startsWith('secret:')) return vars.secret(name.slice(7).trim());
  if (name.startsWith('$')) return dynamic(name);
  return vars.get(name);
}

/**
 * Interpolate strings inside any JSON-like value. A string that is exactly one placeholder
 * keeps the variable's type (so numbers/booleans/objects stay typed in GraphQL variables).
 * Unresolved names are pushed to `missing` and left in place.
 */
export function interpolate(value, vars, missing = [], depth = 0) {
  if (typeof value === 'string') {
    // a value may itself hold placeholders (e.g. apiKey: "{{secret:X}}"); a few levels deep at most, so a loop stops
    const nested = (v) => (depth < 5 && typeof v === 'string' && v.includes('{{') ? interpolate(v, vars, missing, depth + 1) : v);
    const whole = value.match(WHOLE);
    if (whole) {
      const v = lookup(whole[1], vars);
      if (v === undefined) {
        missing.push(whole[1]);
        return value;
      }
      return nested(v);
    }
    return value.replace(PLACEHOLDER, (m, name) => {
      const v = lookup(name, vars);
      if (v === undefined) {
        missing.push(name);
        return m;
      }
      return typeof v === 'object' ? JSON.stringify(v) : String(nested(v));
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, missing, depth));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars, missing, depth)]));
  }
  return value;
}
