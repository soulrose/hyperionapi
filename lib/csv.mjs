// Minimal CSV (RFC 4180 quotes) / JSON data-file reader for data-driven runs.
import { readFile } from 'node:fs/promises';

export async function readDataFile(file) {
  const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
  if (file.endsWith('.json')) return JSON.parse(text);
  const rows = parseCsv(text).filter((r) => r.some((v) => v !== ''));
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += ch;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  return rows;
}
