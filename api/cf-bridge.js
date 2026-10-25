// Universal CORS bridge — runs on BOTH:
//   • Vercel Edge Functions   (default export = function)
//   • Cloudflare Workers      (default export = { fetch })

// Vercel: declares edge runtime. Workers: ignored (just a named export).
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

async function handler(request /*, env, ctx — Workers passes these; Vercel doesn't. Ignored. */) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

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

  // Forward incoming headers, scrub internal edge headers.
  // NOTE: we do NOT set Host — both Vercel and CF derive it from targetUrl
  //       automatically, and setting it manually is at best a no-op,
  //       at worst throws on Workers.
  const fwdHeaders = new Headers();
  const dropHeaders = [
    'host', 'connection',
    'cf-connecting-ip', 'cf-ray', 'cf-visitor',
    'x-forwarded-for', 'x-forwarded-proto'
  ];
  for (const [k, v] of request.headers.entries()) {
    if (!dropHeaders.includes(k.toLowerCase()) && !k.startsWith('x-vercel-')) {
      fwdHeaders.set(k, v);
    }
  }

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

// -------- Dual-runtime export shim --------
handler.fetch = handler;
export default handler;

// Optional Deno Deploy. `Deno` is undefined on both Vercel Edge and Workers,
// so this block is dead code there — harmless.
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(handler);
}