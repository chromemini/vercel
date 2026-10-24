// Vercel Edge Function — Universal BYOK CORS Bridge
export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const reqUrl = new URL(request.url);
  // Extract target from ?url= parameter, x-target-url header, or path
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

  // Forward incoming credentials and headers, scrub internal edge headers
  const fwdHeaders = new Headers();
  const dropHeaders = ['host', 'connection', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-proto'];
  for (const [k, v] of request.headers.entries()) {
    if (!dropHeaders.includes(k.toLowerCase()) && !k.startsWith('x-vercel-')) {
      fwdHeaders.set(k, v);
    }
  }
  fwdHeaders.set('host', targetUrl.host);

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
    });

    const outHeaders = new Headers(CORS_HEADERS);
    outHeaders.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
    outHeaders.set('Cache-Control', 'no-cache, no-transform');
    outHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders
    });
  } catch (err) {
    return json({ error: { message: 'Upstream connection failed: ' + err.message } }, 502);
  }
}