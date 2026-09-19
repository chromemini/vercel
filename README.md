# cf-bridge-five

Vercel Edge bridge for **Cloudflare Workers AI** — bypasses browser CORS so the YAP translation app (hosted on Cloudflare Pages) can call `@cf/*` models directly with the user's own Cloudflare credentials.

## Why this exists

Cloudflare's `api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions` endpoint does **not** return permissive CORS headers, so browsers block direct calls from `https://yap.umer.ai`. This Edge Function is a stateless pass-through that:

1. Accepts a `POST` from the browser with the user's Cloudflare credentials in the JSON body.
2. Forwards the request to Cloudflare Workers AI.
3. Streams the SSE response body straight back to the browser with proper CORS headers attached.

**BYOK is preserved end-to-end.** Credentials are read per-request from the body, never stored, logged, or persisted server-side.

## Endpoint

```
POST https://cf-bridge-five.vercel.app/api/cf-bridge
```

### Required request headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |

### Request body

Standard OpenAI-compatible chat completion payload with two BYOK transport fields merged in. The bridge strips `__cf_account_id` and `__cf_api_token` before forwarding to Cloudflare:

```json
{
  "model": "@cf/zai-org/glm-5.3",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.2,
  "stream": true,
  "reasoning_effort": "medium",
  "__cf_account_id": "your 32-char Cloudflare Account ID",
  "__cf_api_token": "your Cloudflare API Token"
}
```

### Response

Streamed SSE (`text/event-stream`), identical to what Cloudflare Workers AI emits. Errors are returned as JSON with an `error.message` field.

## Deploy

### Option A — Vercel Dashboard

1. Push this folder to a Git repo (GitHub / GitLab / Bitbucket).
2. On Vercel, click **Add New Project** → import the repo.
3. Framework preset: **Other**. Build command: *(leave empty)*. Output directory: *(leave empty)*.
4. Click **Deploy**. Vercel auto-detects `api/cf-bridge.js` as an Edge Function from `vercel.json`.
5. Your endpoint is live at `https://<your-project>.vercel.app/api/cf-bridge`.

### Option B — Vercel CLI

```bash
npm i -g vercel
vercel login
vercel --prod
```

Follow the prompts (project name: `cf-bridge-five`), then copy the production URL.

## Verify deployment

```bash
curl -i -X OPTIONS https://cf-bridge-five.vercel.app/api/cf-bridge
```

You should see:

```
HTTP/2 204
access-control-allow-origin: *
access-control-allow-methods: POST, OPTIONS
access-control-allow-headers: Content-Type
```

If those headers appear, the YAP frontend can consume this bridge without any CORS errors.

## Wiring up the YAP app

In the YAP frontend (`js/api.js`):

```javascript
window.CF_BRIDGE_URL = 'https://cf-bridge-five.vercel.app/api/cf-bridge';
```

The app already routes `@cf/*` model calls through this URL when the user has configured Cloudflare credentials via the in-app **Cloudflare** modal.

## Security notes

- **No secrets on the server.** The bridge reads the user's Account ID and API Token per request from the JSON body and never persists them. There is nothing to leak from Vercel's side.
- **Open CORS (`*`) is intentional.** The bridge is a public utility; credentials travel in the request body. Any origin can call it, but without valid Cloudflare credentials in the payload, the request fails at Cloudflare with 401/403.
- **Account ID format is validated** (`^[a-f0-9]{32}$`) to prevent SSRF or malformed upstream URLs.
- **Rate limiting:** If you're worried about abusive traffic consuming your Vercel Edge quota, add IP-based rate limiting via Upstash Redis or Vercel KV. For most BYOK setups this is unnecessary — Cloudflare itself throttles the user's account.
- **Custom domain (optional):** To avoid third-party-cookie-like restrictions on some enterprise browsers, you may attach a custom domain (e.g., `bridge.yourdomain.com`) via Vercel → Domains.

## License

MIT.