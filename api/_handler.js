const DEFAULT_TIMEOUT_MS = 60000;

const BASE_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'Access-Control-Expose-Headers':
    'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, Content-Type, Content-Length',
  'Access-Control-Max-Age': '86400'
};

const DROP_EXACT = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-worker', 'cf-ipcountry', 'cf-ew-via',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
  'origin', 'referer', 'cookie',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-full-version',
  'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model', 'sec-ch-ua-platform-version',
  'priority', 'dnt',
  'accept-encoding', 'content-length',
  'x-target-url', 'x-forward-origin'
]);

const DROP_PREFIXES = ['x-vercel-'];

const cors = (extra = {}) => ({ ...BASE_CORS_HEADERS, ...extra });

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra })
  });

function pickTarget(reqUrl, request) {
  const q = reqUrl.searchParams.get('url');
  if (q) return q;
  const h = request.headers.get('x-target-url');
  if (h) return h;
  const m = reqUrl.pathname.match(/\/api\/cf-bridge\/(https?:\/\/.+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return null;
}

function assertSafeTarget(u) {
  if (!/^https?:$/.test(u.protocol)) return 'Only http(s) targets are allowed';
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]' ||
    h.endsWith('.local') || h.endsWith('.internal') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) ||
    /^fc00:/i.test(h) || /^fe80:/i.test(h)
  ) return 'Target host is not allowed (private / loopback / link-local)';
  return null;
}

function buildForwardHeaders(request, reqUrl) {
  const out = new Headers();
  for (const [rawK, v] of request.headers.entries()) {
    const k = rawK.toLowerCase();
    if (DROP_EXACT.has(k)) continue;
    if (DROP_PREFIXES.some(p => k.startsWith(p))) continue;
    out.set(rawK, v);
  }

  const override =
    reqUrl.searchParams.get('origin') ||
    request.headers.get('x-forward-origin') ||
    (typeof process !== 'undefined' && process.env && process.env.FORWARD_ORIGIN) ||
    null;
  if (override) out.set('origin', override);

  if (!out.has('accept')) out.set('accept', 'application/json, text/event-stream');

  return out;
}

export async function handler(request) {
  if (request.method === 'OPTIONS') {
    const requested = request.headers.get('access-control-request-headers');
    return new Response(null, {
      status: 204,
      headers: cors(requested ? { 'Access-Control-Allow-Headers': requested } : {})
    });
  }

  const reqUrl = new URL(request.url);
  const target = pickTarget(reqUrl, request);
  if (!target) {
    return json({
      error: { message:
        'Missing target URL. Use ?url=https://host/path, X-Target-URL header, or /api/cf-bridge/<url>.' }
    }, 400);
  }

  let targetUrl;
  try { targetUrl = new URL(target); } catch {
    return json({ error: { message: 'Invalid target URL: ' + target } }, 400);
  }

  const unsafe = assertSafeTarget(targetUrl);
  if (unsafe) return json({ error: { message: unsafe } }, 400);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: buildForwardHeaders(request, reqUrl),
      body: hasBody ? request.body : undefined,
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    return json(
      { error: { message: aborted
        ? 'Upstream timed out'
        : 'Upstream connection failed: ' + (err && err.message) } },
      aborted ? 504 : 502
    );
  }
  clearTimeout(timer);

  const outHeaders = new Headers(BASE_CORS_HEADERS);
  const ct = upstream.headers.get('content-type');
  if (ct) outHeaders.set('content-type', ct);
  const ce = upstream.headers.get('content-encoding');
  if (ce) outHeaders.set('content-encoding', ce);
  outHeaders.set('cache-control', 'no-cache, no-transform');
  outHeaders.set('x-accel-buffering', 'no');

  for (const h of ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }

  const nullBody = [204, 205, 304].includes(upstream.status);
  return new Response(nullBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders
  });
}