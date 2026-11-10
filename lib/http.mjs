// Thin wrapper over undici's fetch (keeps connections alive per origin; certificate checks per Settings).
import { fetch as undiciFetch } from 'undici';
import { tlsAgent, defaultTimeoutMs } from './tls.mjs';

export async function send({ method = 'GET', url, headers = {}, body, timeoutMs }) {
  timeoutMs ??= defaultTimeoutMs();
  const started = performance.now();
  let res;
  try {
    const init = {
      method,
      headers,
      body: body == null || typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    };
    // certificate checks follow Settings (not NODE_TLS_REJECT_UNAUTHORIZED)
    res = await undiciFetch(url, { ...init, dispatcher: tlsAgent() });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timeout after ${timeoutMs / 1000} s (Settings → Request timeout)` : err.cause?.code ?? err.message;
    throw new Error(`${method} ${url} failed: ${reason}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: res.status,
    ok: res.ok,
    headers: Object.fromEntries(res.headers),
    text,
    json,
    timeMs: Math.round(performance.now() - started),
    size: Buffer.byteLength(text),
  };
}
