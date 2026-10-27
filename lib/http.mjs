// Thin wrapper over Node's built-in fetch (undici keeps connections alive per origin).

export async function send({ method = 'GET', url, headers = {}, body, timeoutMs = 15000 }) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body == null || typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.cause?.code ?? err.message;
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
