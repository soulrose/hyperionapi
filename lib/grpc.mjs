// gRPC: load a .proto, list services / methods (with an example message), call unary or streaming methods.
import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { customSession } from './realtime.mjs';

const LOAD = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const cache = new Map();

async function load(file, includeDirs = []) {
  const key = `${file}|${includeDirs.join(';')}`;
  if (!cache.has(key)) cache.set(key, protoLoader.load(file, { ...LOAD, includeDirs: [path.dirname(file), ...includeDirs] }));
  return cache.get(key);
}
export const forgetProtos = () => cache.clear();

const SCALAR = {
  TYPE_STRING: '', TYPE_BYTES: '', TYPE_BOOL: false,
  TYPE_DOUBLE: 0, TYPE_FLOAT: 0, TYPE_INT32: 0, TYPE_UINT32: 0, TYPE_SINT32: 0, TYPE_FIXED32: 0, TYPE_SFIXED32: 0,
  TYPE_INT64: '0', TYPE_UINT64: '0', TYPE_SINT64: '0', TYPE_FIXED64: '0', TYPE_SFIXED64: '0',
};

/** A field's type name is relative to its package ("Who" for demo.Who): match it by the end of the full name. */
function findType(def, typeName) {
  const n = String(typeName ?? '').replace(/^\./, '');
  if (!n) return undefined;
  const key = n in def ? n : Object.keys(def).find((k) => k.endsWith(`.${n}`));
  return key ? def[key].type : undefined;
}

/** An example JSON message from a message descriptor (nested messages up to a few levels). */
function sample(def, t, depth = 0) {
  if (!t?.field) return {};
  const out = {};
  for (const f of t.field) {
    let v;
    if (f.type === 'TYPE_MESSAGE') v = depth < 3 ? sample(def, findType(def, f.typeName), depth + 1) : {};
    else if (f.type === 'TYPE_ENUM') v = findType(def, f.typeName)?.value?.[0]?.name ?? '';
    else v = SCALAR[f.type] ?? null;
    out[f.name] = f.label === 'LABEL_REPEATED' ? [v] : v;
  }
  return out;
}

/** Services and methods in a .proto file. */
export async function describeProto(file, includeDirs) {
  const def = await load(file, includeDirs);
  const services = [];
  for (const [name, value] of Object.entries(def)) {
    if (!value || value.format || typeof value !== 'object') continue; // message / enum entries carry "format"
    const methods = Object.entries(value)
      .filter(([, m]) => m && m.path)
      .map(([mName, m]) => ({
        name: mName,
        requestType: m.requestType?.type?.name,
        responseType: m.responseType?.type?.name,
        requestStream: !!m.requestStream,
        responseStream: !!m.responseStream,
        example: sample(def, m.requestType?.type),
      }));
    if (methods.length) services.push({ name, methods });
  }
  return services;
}

async function clientFor({ file, includeDirs, address, tls, service }) {
  const def = await load(file, includeDirs);
  const pkg = grpc.loadPackageDefinition(def);
  const Ctor = service.split('.').reduce((o, k) => o?.[k], pkg);
  if (typeof Ctor !== 'function') throw new Error(`Service ${service} not found in ${path.basename(file)}`);
  const creds = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  return new Ctor(address.replace(/^grpcs?:\/\//, ''), creds);
}

function toMetadata(headers = {}) {
  const md = new grpc.Metadata();
  for (const [k, v] of Object.entries(headers)) if (k && v != null && v !== '') md.add(k.toLowerCase(), String(v));
  return md;
}

const statusName = (code) => Object.keys(grpc.status).find((k) => grpc.status[k] === code) ?? String(code);

/**
 * Call a method. Unary / client-streaming → { ok, code, status, response, timeMs }.
 * Server- or bidi-streaming → { session } whose log receives each message (send() / close() for client streams).
 */
export async function callGrpc({ file, includeDirs, address, tls, service, method, message = {}, headers, deadlineMs = 15000 }) {
  const client = await clientFor({ file, includeDirs, address, tls, service });
  const desc = (await describeProto(file, includeDirs)).find((s) => s.name === service)?.methods.find((m) => m.name === method);
  if (!desc) throw new Error(`Method ${service}/${method} not found`);
  const md = toMetadata(headers);
  const deadline = new Date(Date.now() + deadlineMs);
  const started = performance.now();

  if (!desc.responseStream) {
    return new Promise((resolve) => {
      const done = (err, response) => {
        client.close();
        resolve({
          ok: !err,
          code: err ? err.code : 0,
          status: err ? statusName(err.code) : 'OK',
          error: err?.details ?? err?.message,
          response: response ?? null,
          timeMs: Math.round(performance.now() - started),
        });
      };
      if (desc.requestStream) {
        // client streaming: the message may be an array of messages
        const call = client[method](md, { deadline }, done);
        for (const m of Array.isArray(message) ? message : [message]) call.write(m);
        call.end();
      } else client[method](message, md, { deadline }, done);
    });
  }

  // server / bidi streaming: a live session the UI follows
  const s = customSession('grpc', { address, service, method });
  const call = desc.requestStream ? client[method](md) : client[method](message, md);
  s.setState('open', `${service}/${method} — waiting for messages`);
  if (desc.requestStream) {
    for (const m of Array.isArray(message) ? message : message && Object.keys(message).length ? [message] : []) {
      call.write(m);
      s.push('out', m);
    }
  }
  call.on('data', (d) => s.push('in', d));
  call.on('error', (err) => s.push('sys', `${statusName(err.code)}: ${err.details ?? err.message}`, { error: true }));
  call.on('end', () => {
    s.setState('closed', `Stream ended (${Math.round(performance.now() - started)} ms)`);
    client.close();
  });
  s.send = (data) => {
    if (!desc.requestStream) throw new Error('This method does not accept more messages (server streaming)');
    call.write(data);
    s.push('out', data);
  };
  s.close = () => {
    if (desc.requestStream) call.end();
    else call.cancel();
  };
  return { session: s, streaming: { request: desc.requestStream, response: true } };
}
