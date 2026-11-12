// Response JSON or XML as tables: pure functions, no DOM (tested from Node)
import { t } from './i18n.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (path, key) => (path === '(root)' ? String(key) : `${path}.${key}`);

/**
 * Every array of objects in the response, and every object that holds values itself (a record such as GraphQL
 * data.patient, one row). Most rows first, then document order: a patient comes before its one-visit list.
 */
export function findTables(json) {
  const tables = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      const rows = v.filter((x) => x != null);
      if (rows.length && rows.some(isObj)) return tables.push({ path, rows: rows.filter(isObj) });
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (isObj(v)) {
      const record = Object.values(v).some((x) => x != null && typeof x !== 'object');
      if (record) tables.push({ path, rows: [v] });
      // a record's nested objects are already its "a.b" columns: only its lists become tables of their own
      for (const [k, x] of Object.entries(v)) if (!record || Array.isArray(x)) walk(x, join(path, k));
    }
  };
  walk(json, '(root)');
  return tables
    .map((x, i) => [x, i])
    .sort((a, b) => b[0].rows.length - a[0].rows.length || a[1] - b[1])
    .map(([x]) => x);
}

const ELEMENT = 1;
const isText = (n) => n.nodeType === 3 || n.nodeType === 4;

function elementValue(el) {
  const kids = [...el.childNodes].filter((n) => n.nodeType === ELEMENT);
  // xmlns:soap has localName "soap", so the declaration is told apart by its full name
  const attrs = [...(el.attributes ?? [])].filter((a) => !/^xmlns(:|$)/.test(a.name ?? a.localName));
  const text = [...el.childNodes].filter(isText).map((n) => n.nodeValue).join('').trim();
  if (!kids.length && !attrs.length) return text;
  const out = {};
  for (const a of attrs) out[`@${a.localName}`] = a.value;
  for (const k of kids) {
    const v = elementValue(k);
    const prev = out[k.localName];
    // an element's value is never an array, so an array here means a repeated sibling
    out[k.localName] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  if (text) out['#text'] = text;
  return out;
}

/** An XML document as JSON-like data for findTables; a SOAP Envelope gives the contents of its Body. */
export function xmlToObject(root) {
  if (root.localName === 'Envelope') {
    const body = [...root.childNodes].find((n) => n.nodeType === ELEMENT && n.localName === 'Body');
    if (body) return elementValue(body);
  }
  return { [root.localName]: elementValue(root) };
}

// nested objects become "a.b" columns, up to 3 keys deep
function flatten(row, prefix = '', depth = 1, out = {}) {
  for (const [k, v] of Object.entries(row)) {
    const key = prefix + k;
    if (isObj(v) && depth < 3 && Object.keys(v).length) flatten(v, `${key}.`, depth + 1, out);
    else out[key] = v;
  }
  return out;
}

export function columnsOf(rows) {
  const cols = new Set();
  for (const row of rows) for (const k of Object.keys(flatten(row))) cols.add(k);
  return [...cols];
}

export function cellText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === 'object') ? t('[{n} items]', { n: v.length }) : v.map(cellText).join(', ');
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
  }
  return String(v);
}

export function flatRow(row, columns) {
  const f = flatten(row);
  return columns.map((c) => cellText(f[c]));
}

export function filterRows(flatRows, query) {
  const q = query.trim().toLocaleLowerCase();
  const all = flatRows.map((_, i) => i);
  return q ? all.filter((i) => flatRows[i].some((c) => c.toLocaleLowerCase().includes(q))) : all;
}

export function sortRows(flatRows, colIndex, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  const num = (s) => (s.trim() === '' ? NaN : Number(s));
  return flatRows
    .map((_, i) => i)
    .sort((i, j) => {
      const a = flatRows[i][colIndex];
      const b = flatRows[j][colIndex];
      if (!a || !b) return !a - !b;
      const na = num(a);
      const nb = num(b);
      return sign * (Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b, 'th', { numeric: true }));
    });
}
