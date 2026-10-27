// Mock realtime servers for tests and the demo: a WebSocket echo server, a Socket.IO (v4) server built on the same
// minimal WebSocket code, and a gRPC server. No extra dependencies besides @grpc/grpc-js.
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

/** The demo gRPC service (also copied into the demo project as protos/echo.proto). */
export const ECHO_PROTO = `syntax = "proto3";
package demo;
service Echo {
  rpc Say (Msg) returns (Msg);
  rpc Count (CountReq) returns (stream Msg);
}
message Msg { string text = 1; int32 n = 2; Who who = 3; }
message Who { string name = 1; }
message CountReq { int32 upTo = 1; }
`;

// ---------- minimal WebSocket server (text frames) ----------
function frame(textData) {
  const payload = Buffer.from(textData);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
  if (!head) {
    const h = Buffer.alloc(10);
    h[0] = 0x81;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return Buffer.concat([h, payload]);
  }
  return Buffer.concat([head, payload]);
}

function accept(req, socket, onText) {
  const key = req.headers['sec-websocket-key'];
  const acceptKey = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  const send = (t) => socket.write(frame(t));
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
      else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
      const masked = buf[1] & 0x80;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(need);
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode === 1) onText(data.toString('utf8'), send);
    }
  });
  socket.on('error', () => {});
  return send;
}

/** WebSocket: /echo answers "echo: <msg>"; /secure needs "Authorization: Bearer good". Socket.IO under /socket.io/. */
export async function startRealtimeMocks({ port = 0, grpcPort = 0 } = {}) {
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/echo') {
      accept(req, socket, (t, send) => send(`echo: ${t}`));
    } else if (u.pathname === '/secure') {
      if (req.headers.authorization !== 'Bearer good') {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      const send = accept(req, socket, (t, s) => s(`secure echo: ${t}`));
      send('welcome');
    } else if (u.pathname === '/socket.io/' && u.searchParams.get('EIO') === '4') {
      const send = accept(req, socket, (t, s) => socketIo(t, s));
      send(`0${JSON.stringify({ sid: 'e1', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`);
    } else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  // Socket.IO v4 packets inside Engine.IO "4": 0 connect, 2 event, 3 ack. Namespace /admin needs auth { token: "good" }.
  function socketIo(t, send) {
    if (t === '3') return; // pong
    if (t[0] !== '4') return;
    let body = t.slice(1);
    const kind = body[0];
    body = body.slice(1);
    let ns = '';
    const nsMatch = body.match(/^(\/[^,]*),/);
    if (nsMatch) (ns = `${nsMatch[1]},`), (body = body.slice(nsMatch[0].length));
    if (kind === '0') {
      const auth = body ? JSON.parse(body) : {};
      if (ns === '/admin,' && auth.token !== 'good') return send(`44${ns}${JSON.stringify({ message: 'unauthorized' })}`);
      return send(`40${ns}${JSON.stringify({ sid: 's1' })}`);
    }
    if (kind === '2') {
      const m = body.match(/^(\d*)(\[[\s\S]*)$/);
      const [event, ...args] = JSON.parse(m[2]);
      if (m[1]) return send(`43${ns}${m[1]}${JSON.stringify([{ ok: true, event }])}`);
      send(`42${ns}${JSON.stringify([`${event}:echo`, ...args])}`);
    }
  }
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  // ---------- gRPC ----------
  const dir = await mkdtemp(path.join(tmpdir(), 'hyperion-grpc-'));
  const protoFile = path.join(dir, 'echo.proto');
  await writeFile(protoFile, ECHO_PROTO);
  const def = await protoLoader.load(protoFile, { keepCase: true, longs: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def);
  const g = new grpc.Server();
  g.addService(pkg.demo.Echo.service, {
    Say: (call, cb) => {
      if (call.metadata.get('authorization')[0] !== 'Bearer good') return cb({ code: grpc.status.UNAUTHENTICATED, details: 'missing token' });
      cb(null, { text: `hello ${call.request.who?.name || call.request.text}`, n: call.request.n + 1 });
    },
    Count: (call) => {
      for (let i = 1; i <= call.request.upTo; i++) call.write({ text: `#${i}`, n: i });
      call.end();
    },
  });
  const boundPort = await new Promise((resolve, reject) => g.bindAsync(`127.0.0.1:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));

  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}`,
    httpUrl: `http://127.0.0.1:${server.address().port}`,
    grpcAddress: `127.0.0.1:${boundPort}`,
    protoFile,
    close: async () => {
      g.forceShutdown();
      await new Promise((r) => server.close(r));
    },
  };
}

export const here = path.dirname(fileURLToPath(import.meta.url));
