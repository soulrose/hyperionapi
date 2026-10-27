// Live connections: WebSocket and Socket.IO (Engine.IO v4 over WebSocket — no socket.io-client needed).
// A session keeps its message log; the UI follows it over Server-Sent Events.
import { randomUUID } from 'node:crypto';

/** Realtime request kinds and the short label the sidebar shows. */
export const RT_KINDS = { WebSocketRequest: 'WS', SocketIORequest: 'SIO', GrpcRequest: 'gRPC' };

const sessions = new Map();

function makeSession(kind, info) {
  const s = { id: randomUUID(), kind, info, state: 'connecting', log: [], listeners: new Set(), socket: null };
  s.push = (dir, data, extra = {}) => {
    const e = { t: Date.now(), dir, data, ...extra };
    s.log.push(e);
    if (s.log.length > 2000) s.log.shift();
    for (const l of s.listeners) l(e);
  };
  s.setState = (state, detail) => {
    s.state = state;
    s.push('sys', detail ?? state, { state });
  };
  sessions.set(s.id, s);
  return s;
}

export const getSession = (id) => sessions.get(id);

export function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    s.close?.();
  } catch {
    // already gone
  }
  sessions.delete(id);
  return true;
}

const text = (data) => (typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));

/** Plain WebSocket. headers: e.g. Authorization; protocols: sub-protocols. */
export function openWebSocket({ url, headers = {}, protocols = [] }) {
  const s = makeSession('websocket', { url });
  const ws = new WebSocket(url, { protocols, headers });
  s.socket = ws;
  ws.onopen = () => s.setState('open', `Connected to ${url}`);
  ws.onmessage = (e) => s.push('in', text(e.data));
  ws.onerror = (e) => s.push('sys', `error: ${e.message ?? e.error?.message ?? 'connection failed'}`, { error: true });
  ws.onclose = (e) => s.setState('closed', `Connection closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`);
  s.send = (data) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    ws.send(payload);
    s.push('out', payload);
  };
  s.close = () => ws.close();
  return s;
}

/** Socket.IO URL → its WebSocket transport URL (http→ws, https→wss, /socket.io/?EIO=4&transport=websocket). */
export function socketIoUrl(url, path = '/socket.io/') {
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = path.endsWith('/') ? path : `${path}/`;
  u.searchParams.set('EIO', '4');
  u.searchParams.set('transport', 'websocket');
  return u.toString();
}

/**
 * Socket.IO client over WebSocket. namespace: "/" or "/chat"; auth: object sent on connect (e.g. { token }).
 * Engine.IO packets: 0 open, 2 ping → 3 pong, 4 message. Socket.IO packets inside 4: 0 connect, 1 disconnect,
 * 2 event, 3 ack, 4 connect error.
 */
export function openSocketIO({ url, path = '/socket.io/', namespace = '/', auth, headers = {} }) {
  const s = makeSession('socketio', { url, namespace });
  const ns = namespace && namespace !== '/' ? `${namespace},` : '';
  const ws = new WebSocket(socketIoUrl(url, path), { headers });
  s.socket = ws;
  let ackId = 0;
  const acks = new Map();
  const sio = (packet) => ws.send(`4${packet}`);
  ws.onmessage = (e) => {
    const raw = text(e.data);
    const type = raw[0];
    if (type === '0') {
      // engine open → connect to the namespace (with auth if any)
      sio(`0${ns}${auth && Object.keys(auth).length ? JSON.stringify(auth) : ''}`);
      return;
    }
    if (type === '2') return void ws.send('3'); // ping → pong (not logged)
    if (type !== '4') return;
    let body = raw.slice(1);
    const kind = body[0];
    body = body.slice(1);
    if (ns && body.startsWith(ns)) body = body.slice(ns.length);
    if (kind === '0') return s.setState('open', `Socket.IO connected to ${url}${ns ? ` (namespace ${namespace})` : ''}`);
    if (kind === '4') return s.push('sys', `Connection failed: ${body}`, { error: true });
    if (kind === '1') return s.setState('closed', 'Server disconnected the namespace');
    const m = body.match(/^(\d*)(\[[\s\S]*)$/);
    if (!m) return;
    let args;
    try {
      args = JSON.parse(m[2]);
    } catch {
      return s.push('in', body);
    }
    if (kind === '2') {
      const [event, ...rest] = args;
      s.push('in', rest.length === 1 ? rest[0] : rest, { event });
    } else if (kind === '3') {
      const cb = acks.get(Number(m[1]));
      acks.delete(Number(m[1]));
      s.push('in', args.length === 1 ? args[0] : args, { event: cb ? `ack: ${cb}` : 'ack' });
    }
  };
  ws.onerror = (e) => s.push('sys', `error: ${e.message ?? e.error?.message ?? 'connection failed'}`, { error: true });
  ws.onclose = (e) => s.setState('closed', `Connection closed (code ${e.code})`);
  /** emit(event, args[], wantAck) */
  s.emit = (event, args = [], wantAck = false) => {
    if (ws.readyState !== WebSocket.OPEN || s.state !== 'open') throw new Error('Not connected');
    const id = wantAck ? ++ackId : '';
    if (wantAck) acks.set(id, event);
    sio(`2${ns}${id}${JSON.stringify([event, ...args])}`);
    s.push('out', args.length === 1 ? args[0] : args, { event });
  };
  s.send = (data) => s.emit('message', [data]);
  s.close = () => {
    try {
      sio(`1${ns}`);
    } catch {
      // socket already closed
    }
    ws.close();
  };
  return s;
}

/** Register a session made elsewhere (gRPC streaming). */
export function customSession(kind, info) {
  return makeSession(kind, info);
}
