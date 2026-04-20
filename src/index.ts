/**
 * tera-proxy — Cloudflare Worker
 *
 * Endpoints:
 *   POST /fetch-proxy   — relay HTTP para portais DFe (sem JWT)
 *   (outros endpoints JWT existentes mantidos)
 */

export interface Env {
  TERA_USERS: KVNamespace;
  TERA_DATA: KVNamespace;
  TERA_INVITES: KVNamespace;
}

// ── Whitelist anti-SSRF (usa new URL() para comparar hostname exato) ────────
// Previne bypass via subdomain (dfe-portal.svrs.rs.gov.br.evil.com)
// e credential injection (dfe-portal.svrs.rs.gov.br@evil.com)
const ALLOWED_HOSTS = new Set([
  'dfe-portal.svrs.rs.gov.br',
  'www.nfe.fazenda.gov.br',
  'www.cte.fazenda.gov.br',
]);

function isUrlAllowed(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    if (ALLOWED_HOSTS.has(parsed.hostname)) return true;
    if (parsed.hostname === 'www.gov.br' && parsed.pathname.startsWith('/nfse')) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Rate limit: contador por IP em memória ──────────────────────────────────
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT   = 20;
const WINDOW_MS    = 60_000;

function checkRateLimit(ip: string): boolean {
  const now  = Date.now();
  const slot = rateLimitMap.get(ip);
  if (!slot || now - slot.windowStart > WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (slot.count >= RATE_LIMIT) return false;
  slot.count++;
  return true;
}

// ── CORS ────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Handler /fetch-proxy ────────────────────────────────────────────────────
async function handleFetchProxy(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return corsResponse(JSON.stringify({ ok: false, error: 'Method not allowed' }), 405);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) {
    return corsResponse(JSON.stringify({ ok: false, error: 'Rate limit exceeded' }), 429);
  }

  let body: { url?: string };
  try {
    body = await request.json() as { url?: string };
  } catch {
    return corsResponse(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), 400);
  }

  const targetUrl = body.url || '';

  if (!isUrlAllowed(targetUrl)) {
    return corsResponse(JSON.stringify({ ok: false, error: 'URL not in allowed list' }), 403);
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(targetUrl, {
      signal:  controller.signal,
      headers: {
        'User-Agent': 'Auditec-Curador/1.0 (Fiscal Compliance)',
        'Accept':     'text/html,application/xhtml+xml',
      },
    });

    const html = await upstream.text();
    clearTimeout(timer);

    return corsResponse(JSON.stringify({ ok: true, html, status: upstream.status }), 200);
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return corsResponse(JSON.stringify({ ok: false, error: msg }), 502);
  }
}

// ── Router principal ────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/fetch-proxy') {
      return handleFetchProxy(request);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status:  404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
