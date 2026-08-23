type Env = {
  APPS_SCRIPT_URL: string;
  ALLOWED_ORIGINS?: string;
};

const CREW_ACTIONS = new Set(['login', 'validate-session', 'bootstrap', 'day-state', 'stop-action', 'photo']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env)
      });
    }

    if (!requestUrl.pathname.startsWith('/api/crew/')) {
      return jsonResponse(request, env, 404, {
        ok: false,
        error: 'Not found.'
      });
    }

    const action = requestUrl.pathname.split('/').filter(Boolean).pop() || '';

    if (!CREW_ACTIONS.has(action)) {
      return jsonResponse(request, env, 404, {
        ok: false,
        error: 'Unsupported Crew API action.'
      });
    }

    if (!env.APPS_SCRIPT_URL) {
      return jsonResponse(request, env, 500, {
        ok: false,
        error: 'Missing APPS_SCRIPT_URL Worker secret.'
      });
    }

    if (!isAllowedMethod(action, request.method)) {
      return jsonResponse(request, env, 405, {
        ok: false,
        error: 'Method not allowed.'
      });
    }

    const requestPayload = request.method === 'GET' ? '' : await request.text();
    const appsScriptUrl = new URL(env.APPS_SCRIPT_URL);
    appsScriptUrl.searchParams.set('api', 'crew');
    appsScriptUrl.searchParams.set('action', action);
    const upstreamUrl = appsScriptUrl.toString();

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: request.method === 'GET' ? undefined : requestPayload,
        redirect: 'follow'
      });

      const body = await upstreamResponse.text();
      const upstreamHeaders = headersToObject(upstreamResponse.headers);

      if (action === 'login' || action === 'bootstrap' || action === 'stop-action') {
        const parsedBody = parseJsonSafe(body);

        if (
          upstreamResponse.ok &&
          (action === 'bootstrap' ||
            (action === 'stop-action' && isSuccessfulCrewApiResponse(parsedBody)) ||
            isSuccessfulCrewLoginResponse(parsedBody))
        ) {
          const headers = corsHeaders(request, env);
          headers.set('Content-Type', 'application/json; charset=utf-8');
          headers.set('Cache-Control', 'no-store');

          return new Response(body, {
          status: upstreamResponse.status,
          headers
        });
      }

        return jsonResponse(request, env, upstreamResponse.status, {
          ok: upstreamResponse.ok,
          source: `crew-worker-${action}-diagnostic`,
          upstreamUrl,
          requestPayload: parseJsonSafe(requestPayload),
          requestPayloadRaw: requestPayload,
          upstreamStatus: upstreamResponse.status,
          upstreamStatusText: upstreamResponse.statusText,
          upstreamHeaders,
          upstreamBody: body
        });
      }

      const headers = corsHeaders(request, env);
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Cache-Control', 'no-store');

      return new Response(body || JSON.stringify({ ok: false, error: 'Empty Crew API response.' }), {
        status: upstreamResponse.status,
        headers
      });
    } catch (err) {
      if (action === 'login' || action === 'bootstrap' || action === 'stop-action') {
        return jsonResponse(request, env, 502, {
          ok: false,
          source: `crew-worker-${action}-diagnostic`,
          upstreamUrl,
          requestPayload: parseJsonSafe(requestPayload),
          requestPayloadRaw: requestPayload,
          exceptionName: err instanceof Error ? err.name : '',
          exceptionMessage: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : ''
        });
      }

      return jsonResponse(request, env, 502, {
        ok: false,
        error: err instanceof Error ? err.message : 'Crew API proxy failed.'
      });
    }
  }
};

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function parseJsonSafe(raw: string): unknown {
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isSuccessfulCrewLoginResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  const response = value as {
    ok?: unknown;
    data?: {
      token?: unknown;
      session_token?: unknown;
      crew_token?: unknown;
    };
  };

  if (response.ok !== true || !response.data) return false;

  return !!String(
    response.data.token || response.data.session_token || response.data.crew_token || ''
  ).trim();
}

function isSuccessfulCrewApiResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { ok?: unknown }).ok === true;
}

function isAllowedMethod(action: string, method: string): boolean {
  if (action === 'bootstrap') return method === 'GET' || method === 'POST';
  return method === 'POST';
}

function jsonResponse(request: Request, env: Env, status: number, payload: Record<string, unknown>): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');

  return new Response(JSON.stringify(payload), {
    status,
    headers
  });
}

function corsHeaders(request: Request, env: Env): Headers {
  const requestOrigin = request.headers.get('Origin') || '';
  const allowedOrigin = resolveAllowedOrigin(requestOrigin, env.ALLOWED_ORIGINS || '');

  return new Headers({
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  });
}

function resolveAllowedOrigin(requestOrigin: string, allowedOrigins: string): string {
  const origins = allowedOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!origins.length) return '*';
  if (requestOrigin && origins.includes(requestOrigin)) return requestOrigin;
  return origins[0];
}
