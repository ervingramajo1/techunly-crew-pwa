# Techunly Crew API Proxy

This Worker is a narrow CORS-safe proxy between the standalone Techunly Crew PWA and the validated Apps Script Crew API.

## Routes

Frontend route:

```text
POST /api/crew/login
POST /api/crew/validate-session
GET  /api/crew/bootstrap
POST /api/crew/bootstrap
```

Apps Script upstream mapping:

```text
{APPS_SCRIPT_URL}?api=crew&action=login
{APPS_SCRIPT_URL}?api=crew&action=validate-session
{APPS_SCRIPT_URL}?api=crew&action=bootstrap
```

## Local Development

From `techunly-crew-pwa/`:

```powershell
npm.cmd install
npx.cmd wrangler secret put APPS_SCRIPT_URL --config cloudflare-worker/wrangler.toml.example
npm.cmd run worker:dev
npm.cmd run dev
```

Use this frontend env for local Vite:

```env
VITE_CREW_API_BASE_URL=http://localhost:8787/api/crew
```

## Deployment

1. Create a Cloudflare Worker.
2. Set the Apps Script deployment URL as a Worker secret:

```powershell
npx.cmd wrangler secret put APPS_SCRIPT_URL --config cloudflare-worker/wrangler.toml.example
```

Use this value:

```text
https://script.google.com/macros/s/AKfycbwRSC08JSw57zD1KI834f0VnwEh0wapXjJCiBfjZsZI44f_sRxvjl0Jey07dRkeaywi-w/exec
```

3. Set `ALLOWED_ORIGINS` in `wrangler.toml` to the production Crew PWA origin, for example:

```toml
ALLOWED_ORIGINS = "https://crew.techunly.com"
```

4. Deploy:

```powershell
npm.cmd run worker:deploy
```

5. Configure Cloudflare Pages so `/api/crew/*` routes to this Worker, or set:

```env
VITE_CREW_API_BASE_URL=https://your-worker.your-subdomain.workers.dev/api/crew
```

## Security

The Worker only exposes Crew API actions. It does not expose CRM, Dispatch Board, Employees HR fields, billing, settings, or admin actions.
