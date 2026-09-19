// Vercel Edge Function — CORS bridge to Cloudflare Workers AI (BYOK)
// Deploy: this file must live at /api/cf-bridge.js of a Vercel project.
// Runtime: Edge (native SSE streaming, no cold-start buffering).
//
// BYOK contract:
//   - Client sends its own Cloudflare Account ID and API Token as custom headers.
//   - This function NEVER stores, logs, or persists credentials.
//   - Stateless per request: read headers -> forward to Cloudflare -> pipe response back.
export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export default async function handler(request) {
  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method Not Allowed' } }, 405);
  }

  // BYOK: credentials arrive in the JSON body, never stored server-side.
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: 'Invalid JSON body' } }, 400);
  }

  const accountId = payload.__cf_account_id;
  const apiToken = payload.__cf_api_token;

  // Strip internal transport fields before forwarding to Cloudflare
  delete payload.__cf_account_id;
  delete payload.__cf_api_token;

  if (!accountId || !apiToken) {
    return jsonResponse({ error: { message: 'Missing Cloudflare Account ID or API Token' } }, 400);
  }

  // Basic shape validation to avoid SSRF-ish abuse via body injection
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    return jsonResponse({ error: { message: 'Invalid Cloudflare Account ID format (expected 32 hex chars)' } }, 400);
  }

  const targetUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return jsonResponse({ error: { message: 'Upstream connection failure: ' + err.message } }, 502);
  }

  // Stream the SSE body straight through with CORS headers attached
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}