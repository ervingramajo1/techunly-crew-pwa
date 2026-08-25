type Env = {
  APPS_SCRIPT_URL: string;
  ALLOWED_ORIGINS?: string;
  STRIPE_CONNECT_WEBHOOK_SECRET?: string;
  WORKER_TO_APPS_SCRIPT_SECRET?: string;
};

const CREW_ACTIONS = new Set(['login', 'validate-session', 'bootstrap', 'day-state', 'stop-action', 'photo']);
const STRIPE_CONNECT_WEBHOOK_PATH = '/webhooks/stripe/connect';
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === STRIPE_CONNECT_WEBHOOK_PATH) {
      return handleStripeConnectWebhook(request, env);
    }

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

async function handleStripeConnectWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return webhookJsonResponse(405, {
      ok: false,
      error: 'Method not allowed.'
    });
  }

  if (!env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    return webhookJsonResponse(500, {
      ok: false,
      error: 'Stripe webhook is not configured.'
    });
  }

  if (!env.WORKER_TO_APPS_SCRIPT_SECRET) {
    return webhookJsonResponse(500, {
      ok: false,
      error: 'Webhook forwarding is not configured.'
    });
  }

  if (!env.APPS_SCRIPT_URL) {
    return webhookJsonResponse(500, {
      ok: false,
      error: 'Missing APPS_SCRIPT_URL Worker secret.'
    });
  }

  const signatureHeader = request.headers.get('Stripe-Signature') || '';
  const rawBody = await request.text();
  const verification = await verifyStripeWebhookSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_CONNECT_WEBHOOK_SECRET
  );

  if (verification.ok !== true) {
    return webhookJsonResponse(400, {
      ok: false,
      error: verification.error
    });
  }

  const event = parseStripeEvent(rawBody);
  if (event.ok !== true) {
    return webhookJsonResponse(400, {
      ok: false,
      error: event.error
    });
  }

  const stripeEvent = event.event;
  const eventId = safeString(stripeEvent.id);
  const eventType = safeString(stripeEvent.type);
  const connectedAccountId = safeString(stripeEvent.account);

  if (!eventId || !eventType || !connectedAccountId) {
    return webhookJsonResponse(400, {
      ok: false,
      error: 'Stripe Connect event is missing required context.'
    });
  }

  if (eventType !== 'checkout.session.completed') {
    return webhookJsonResponse(200, {
      ok: true,
      ignored: true,
      event_id: eventId,
      event_type: eventType
    });
  }

  const session = normalizeCheckoutSession(stripeEvent.data?.object);
  if (!session) {
    return webhookJsonResponse(400, {
      ok: false,
      error: 'Stripe checkout session payload is invalid.'
    });
  }

  const envelope = {
    techunly_webhook_verified: true,
    intermediary_secret: env.WORKER_TO_APPS_SCRIPT_SECRET,
    stripe_event_id: eventId,
    stripe_event_type: eventType,
    stripe_connected_account_id: connectedAccountId,
    created: stripeEvent.created || '',
    livemode: stripeEvent.livemode === true,
    stripe_event: {
      id: eventId,
      type: eventType,
      account: connectedAccountId,
      created: stripeEvent.created || '',
      livemode: stripeEvent.livemode === true,
      data: {
        object: session
      }
    }
  };

  try {
    const upstreamResponse = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(envelope),
      redirect: 'follow'
    });
    const body = await upstreamResponse.text();

    if (!upstreamResponse.ok || isAppsScriptWebhookFailure(body)) {
      return webhookJsonResponse(502, {
        ok: false,
        event_id: eventId,
        event_type: eventType,
        error: 'Stripe payment reconciliation failed.'
      });
    }

    return webhookJsonResponse(200, {
      ok: true,
      event_id: eventId,
      event_type: eventType,
      forwarded: true
    });
  } catch {
    return webhookJsonResponse(502, {
      ok: false,
      event_id: eventId,
      event_type: eventType,
      error: 'Stripe payment reconciliation failed.'
    });
  }
}

async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!signatureHeader) {
    return { ok: false, error: 'Missing Stripe-Signature.' };
  }

  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed.timestamp || !parsed.signatures.length) {
    return { ok: false, error: 'Malformed Stripe-Signature.' };
  }

  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, error: 'Malformed Stripe-Signature.' };
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, error: 'Stale Stripe-Signature.' };
  }

  const expected = await hmacSha256Hex(`${parsed.timestamp}.${rawBody}`, secret);
  const valid = parsed.signatures.some((signature) => timingSafeEqualHex(signature, expected));
  return valid ? { ok: true } : { ok: false, error: 'Invalid Stripe-Signature.' };
}

function parseStripeSignatureHeader(header: string): { timestamp: string; signatures: string[] } {
  const parts = header.split(',').map((part) => part.trim()).filter(Boolean);
  let timestamp = '';
  const signatures: string[] = [];

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  return { timestamp, signatures };
}

async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const cleanLeft = safeString(left).toLowerCase();
  const cleanRight = safeString(right).toLowerCase();
  if (!/^[a-f0-9]+$/.test(cleanLeft) || !/^[a-f0-9]+$/.test(cleanRight)) return false;

  const maxLength = Math.max(cleanLeft.length, cleanRight.length);
  let mismatch = cleanLeft.length === cleanRight.length ? 0 : 1;
  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < cleanLeft.length ? cleanLeft.charCodeAt(index) : 0;
    const rightCode = index < cleanRight.length ? cleanRight.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }
  return mismatch === 0;
}

function parseStripeEvent(rawBody: string):
  | { ok: true; event: Record<string, any> }
  | { ok: false; error: string } {
  try {
    const event = JSON.parse(rawBody);
    if (!event || typeof event !== 'object') {
      return { ok: false, error: 'Stripe event payload is invalid.' };
    }
    return { ok: true, event };
  } catch {
    return { ok: false, error: 'Stripe event payload is invalid JSON.' };
  }
}

function normalizeCheckoutSession(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Record<string, any>;
  const metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};

  return {
    id: safeString(session.id),
    object: safeString(session.object || 'checkout.session'),
    mode: safeString(session.mode),
    payment_status: safeString(session.payment_status),
    payment_intent: safeString(session.payment_intent),
    amount_total: session.amount_total || 0,
    amount_subtotal: session.amount_subtotal || 0,
    currency: safeString(session.currency),
    customer: safeString(session.customer),
    client_reference_id: safeString(session.client_reference_id),
    metadata: {
      payment_domain: safeString(metadata.payment_domain),
      company_id: safeString(metadata.company_id),
      invoice_id: safeString(metadata.invoice_id),
      invoice_number: safeString(metadata.invoice_number),
      client_id: safeString(metadata.client_id)
    }
  };
}

function isAppsScriptWebhookFailure(body: string): boolean {
  const parsed = parseJsonSafe(body);
  if (!parsed || typeof parsed !== 'object') return false;
  return (parsed as { ok?: unknown }).ok === false;
}

function webhookJsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

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

function safeString(value: unknown): string {
  return String(value || '').trim();
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
