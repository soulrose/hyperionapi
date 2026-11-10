// SSL certificate verification (Settings; on by default). Off = self-signed and internal-CA certificates are accepted
// for every kind of request: HTTP (REST / GraphQL / SOAP / logins / schema), WebSocket / Socket.IO and gRPC.
// Kept per computer in ~/.hyperion/settings.json; HYPERION_SSL_VERIFY=false does the same for the CLI / CI.
// The same file keeps the default request timeout (Settings; HYPERION_TIMEOUT_MS for the CLI / CI).
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from 'undici';

const FILE = path.join(process.env.HYPERION_PROJECTS_FILE ? path.dirname(process.env.HYPERION_PROJECTS_FILE) : path.join(os.homedir(), '.hyperion'), 'settings.json');

let settings;
function read() {
  if (!settings) {
    try {
      settings = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      settings = {};
    }
  }
  return settings;
}

export function sslVerify() {
  if (/^(0|false|no|off)$/i.test(process.env.HYPERION_SSL_VERIFY ?? '')) return false;
  return read().sslVerify !== false;
}

export async function setSslVerify(on) {
  settings = { ...read(), sslVerify: !!on };
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(settings, null, 2), 'utf8');
  return sslVerify();
}

export const DEFAULT_TIMEOUT_MS = 15000;

/** Timeout for requests that set none themselves (or in their collection): logins, schema and WSDL loads included. */
export function defaultTimeoutMs() {
  const v = Number(process.env.HYPERION_TIMEOUT_MS || read().timeoutMs);
  return v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

export async function setDefaultTimeoutMs(ms) {
  const v = Math.round(Number(ms));
  settings = { ...read(), timeoutMs: v > 0 ? v : DEFAULT_TIMEOUT_MS };
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(settings, null, 2), 'utf8');
  return defaultTimeoutMs();
}

/** NODE_TLS_REJECT_UNAUTHORIZED=0 on this computer switches checks off for every Node program; Hyperion's switch decides. */
export const globalTlsOff = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

let secure;
let insecure;
/** The undici dispatcher for the current setting: certificate checks stated explicitly either way. */
export function tlsAgent() {
  if (sslVerify()) return (secure ??= new Agent({ connect: { rejectUnauthorized: true } }));
  return (insecure ??= new Agent({ connect: { rejectUnauthorized: false } }));
}
