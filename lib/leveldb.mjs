// Minimal read-only LevelDB reader (tables + write-ahead log) with snappy — enough to read a Chromium IndexedDB
// folder such as Postman desktop's local store. No dependencies.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function varint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [result, pos];
    shift += 7;
  }
}

/** Snappy raw block decompression. */
export function unsnappy(src) {
  let [len, pos] = varint(src, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = src.readUIntLE(pos, bytes);
        pos += bytes;
      }
      n += 1;
      src.copy(out, o, pos, pos + n);
      pos += n;
      o += n;
      continue;
    }
    let n;
    let off;
    if (kind === 1) {
      n = 4 + ((tag >> 2) & 7);
      off = ((tag >> 5) << 8) | src[pos++];
    } else if (kind === 2) {
      n = (tag >> 2) + 1;
      off = src.readUInt16LE(pos);
      pos += 2;
    } else {
      n = (tag >> 2) + 1;
      off = src.readUInt32LE(pos);
      pos += 4;
    }
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off]; // overlapping copies are allowed
  }
  return out;
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size]; // trailer: 1 byte compression + 4 byte crc
  return type === 1 ? unsnappy(raw) : raw;
}

function* blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - restarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < end) {
    let shared, nonShared, valueLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    yield [key, value];
  }
}

/** All entries of one .ldb/.sst table: { key (user key), seq, deleted, value }. */
export function* tableEntries(file) {
  const footer = file.subarray(file.length - 48);
  let pos = 0;
  let metaOff, metaSize, idxOff, idxSize;
  [metaOff, pos] = varint(footer, pos);
  [metaSize, pos] = varint(footer, pos);
  [idxOff, pos] = varint(footer, pos);
  [idxSize, pos] = varint(footer, pos);
  for (const [, handle] of blockEntries(readBlock(file, idxOff, idxSize))) {
    let off, size;
    let p = 0;
    [off, p] = varint(handle, p);
    [size, p] = varint(handle, p);
    for (const [ikey, value] of blockEntries(readBlock(file, off, size))) {
      const tail = ikey.readBigUInt64LE(ikey.length - 8);
      yield { key: ikey.subarray(0, ikey.length - 8), seq: Number(tail >> 8n), deleted: Number(tail & 0xffn) === 0, value };
    }
  }
}

/** All entries written to a .log file (newer than the tables). */
export function* logEntries(file) {
  const records = [];
  let partial = [];
  for (let block = 0; block < file.length; block += 32768) {
    let pos = block;
    const end = Math.min(block + 32768, file.length);
    while (pos + 7 <= end) {
      const len = file.readUInt16LE(pos + 4);
      const type = file[pos + 6];
      if (type === 0 && len === 0) break; // zero padding at the end of a block
      const data = file.subarray(pos + 7, pos + 7 + len);
      pos += 7 + len;
      if (type === 1) records.push(data);
      else if (type === 2) partial = [data];
      else if (type === 3) partial.push(data);
      else if (type === 4) records.push(Buffer.concat([...partial, data])), (partial = []);
    }
  }
  for (const batch of records) {
    let seq = Number(batch.readBigUInt64LE(0));
    const count = batch.readUInt32LE(8);
    let pos = 12;
    for (let i = 0; i < count && pos < batch.length; i++, seq++) {
      const tag = batch[pos++];
      let klen;
      [klen, pos] = varint(batch, pos);
      const key = batch.subarray(pos, pos + klen);
      pos += klen;
      if (tag === 1) {
        let vlen;
        [vlen, pos] = varint(batch, pos);
        yield { key, seq, deleted: false, value: batch.subarray(pos, pos + vlen) };
        pos += vlen;
      } else yield { key, seq, deleted: true, value: null };
    }
  }
}

/** Latest live value per key across every table and log in a LevelDB folder. */
export async function readLevelDb(dir) {
  const latest = new Map();
  const take = (e) => {
    const k = e.key.toString('latin1');
    const cur = latest.get(k);
    if (!cur || e.seq >= cur.seq) latest.set(k, e);
  };
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    try {
      if (name.endsWith('.ldb') || name.endsWith('.sst')) for (const e of tableEntries(await readFile(full))) take(e);
      else if (name.endsWith('.log') && /^\d+\.log$/.test(name)) for (const e of logEntries(await readFile(full))) take(e);
    } catch {
      // a file being written right now can be cut short: skip what cannot be read
    }
  }
  return [...latest.values()].filter((e) => !e.deleted);
}
