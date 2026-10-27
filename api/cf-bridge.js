// Universal CORS Bridge — Optimized for Cloudflare Workers (LLMs + MCP)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Content-Type, Content-Length',
  'Access-Control-Max-Age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export async function handler(request) {
  // 1. Handle CORS Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 2. Parse target URL
  const reqUrl = new URL(request.url);
  let target = reqUrl.searchParams.get('url') || request.headers.get('x-target-url');

  if (!target) {
    const m = reqUrl.pathname.match(/\/api\/cf-bridge\/(https?:\/\/.+)/);
    if (m) target = m[1];
  }

  if (!target) {
    return json({ error: { message: 'Missing target URL. Pass ?url=https://api.endpoint/v1' } }, 400);
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (_) {
    return json({ error: { message: 'Invalid target URL: ' + target } }, 400);
  }

  // 3. Clean headers (Scrub Cloudflare internal headers to prevent subrequest loops)
  const fwdHeaders = new Headers();
  const dropHeaders = [
    'host', 'connection',
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-worker',
    'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'
  ];

  for (const [k, v] of request.headers.entries()) {
    if (!dropHeaders.includes(k.toLowerCase())) {
      fwdHeaders.set(k, v);
    }
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow'
    });

    const outHeaders = new Headers(CORS_HEADERS);
    outHeaders.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    outHeaders.set('Cache-Control', 'no-cache, no-transform');
    outHeaders.set('X-Accel-Buffering', 'no');

    // Forward MCP session header if upstream provides it
    const mcpSession = upstream.headers.get('mcp-session-id');
    if (mcpSession) {
      outHeaders.set('Mcp-Session-Id', mcpSession);
    }

    // Cloudflare Workers safety: 204, 205, and 304 responses MUST have a null body
    const isNullBodyStatus = [204, 205, 304].includes(upstream.status);
    const responseBody = isNullBodyStatus ? null : upstream.body;

    return new Response(responseBody, {
      status: upstream.status,
      headers: outHeaders
    });
  } catch (err) {
    return json({ error: { message: 'Upstream connection failed: ' + err.message } }, 502);
  }
}

// Canonical Cloudflare Workers ES Module export
export default {
  fetch: handler
};