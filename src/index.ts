/**
 * tera-proxy — Cloudflare Worker
 *
 * Endpoints de autenticação:
 *   POST /auth/login        — login com username + password
 *   POST /auth/register     — registo com username + password + inviteCode
 *   GET  /auth/me           — retorna dados do utilizador autenticado
 *   POST /auth/logout       — invalida o token de sessão
 *
 * Endpoints de dados (KV por utilizador):
 *   GET  /kv-list           — lista todas as chaves do utilizador
 *   GET  /kv/:key           — lê o valor de uma chave
 *   PUT  /kv/:key           — escreve o valor de uma chave
 *   DELETE /kv/:key         — apaga uma chave
 *
 * Endpoints de API Key:
 *   GET    /user/apikey     — verifica se tem API key configurada
 *   PUT    /user/apikey     — guarda a API key
 *   DELETE /user/apikey     — remove a API key
 *
 * Endpoints de proxy:
 *   POST /fetch-proxy       — relay HTTP para portais DFe (sem JWT)
 *   POST /api/anthropic     — proxy para a API Anthropic
 */

export interface Env {
  TERA_USERS: KVNamespace;
  TERA_DATA: KVNamespace;
  TERA_INVITES: KVNamespace;
}

// ── CORS ────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonOk(data: unknown): Response {
  return corsResponse(JSON.stringify(data), 200);
}

function jsonErr(msg: string, status = 400): Response {
  return corsResponse(JSON.stringify({ error: msg }), status);
}

// ── Helpers de token ─────────────────────────────────────────────────────────
function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateUserId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Hash de password com SHA-256 ─────────────────────────────────────────────
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'tera-salt-2024');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Extrair token do header Authorization ────────────────────────────────────
function extractToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

// ── Verificar autenticação ───────────────────────────────────────────────────
async function authenticate(token: string | null, env: Env): Promise<{ userId: string; username: string } | null> {
  if (!token) return null;
  const sessionJson = await env.TERA_USERS.get(`session:${token}`);
  if (!sessionJson) return null;
  try {
    return JSON.parse(sessionJson);
  } catch {
    return null;
  }
}

// ── POST /auth/login ─────────────────────────────────────────────────────────
async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string };
  try { body = await request.json() as typeof body; } catch { return jsonErr('JSON inválido'); }

  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';

  if (!username || !password) return jsonErr('Utilizador e senha são obrigatórios');

  const userJson = await env.TERA_USERS.get(`user:${username}`);
  if (!userJson) return jsonErr('Utilizador ou senha incorretos', 401);

  let user: { userId: string; username: string; passwordHash: string };
  try { user = JSON.parse(userJson); } catch { return jsonErr('Erro interno', 500); }

  const hash = await hashPassword(password);
  if (hash !== user.passwordHash) return jsonErr('Utilizador ou senha incorretos', 401);

  const token = generateToken();
  await env.TERA_USERS.put(`session:${token}`, JSON.stringify({ userId: user.userId, username: user.username }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 dias

  return jsonOk({ token, username: user.username, userId: user.userId });
}

// ── POST /auth/register ──────────────────────────────────────────────────────
async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string; inviteCode?: string };
  try { body = await request.json() as typeof body; } catch { return jsonErr('JSON inválido'); }

  const username = (body.username || '').trim().toLowerCase();
  const password = body.password || '';
  const inviteCode = (body.inviteCode || '').trim().toUpperCase();

  if (!username || !password) return jsonErr('Utilizador e senha são obrigatórios');
  if (username.length < 3) return jsonErr('Utilizador deve ter pelo menos 3 caracteres');
  if (password.length < 6) return jsonErr('Senha deve ter pelo menos 6 caracteres');
  if (!inviteCode) return jsonErr('Código de convite é obrigatório');

  // Verificar código de convite
  const inviteJson = await env.TERA_INVITES.get(`invite:${inviteCode}`);
  if (!inviteJson) return jsonErr('Código de convite inválido ou expirado', 403);

  let invite: { used?: boolean; maxUses?: number; uses?: number };
  try { invite = JSON.parse(inviteJson); } catch { return jsonErr('Erro interno', 500); }

  if (invite.used) return jsonErr('Código de convite já utilizado', 403);
  if (invite.maxUses && (invite.uses || 0) >= invite.maxUses) return jsonErr('Código de convite esgotado', 403);

  // Verificar se utilizador já existe
  const existing = await env.TERA_USERS.get(`user:${username}`);
  if (existing) return jsonErr('Utilizador já existe', 409);

  const userId = generateUserId();
  const passwordHash = await hashPassword(password);

  await env.TERA_USERS.put(`user:${username}`, JSON.stringify({ userId, username, passwordHash }));

  // Marcar convite como usado
  const uses = (invite.uses || 0) + 1;
  const maxUses = invite.maxUses || 1;
  await env.TERA_INVITES.put(`invite:${inviteCode}`, JSON.stringify({ ...invite, uses, used: uses >= maxUses }));

  const token = generateToken();
  await env.TERA_USERS.put(`session:${token}`, JSON.stringify({ userId, username }), { expirationTtl: 60 * 60 * 24 * 30 });

  return jsonOk({ token, username, userId });
}

// ── GET /auth/me ─────────────────────────────────────────────────────────────
async function handleMe(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);
  return jsonOk({ userId: session.userId, username: session.username });
}

// ── POST /auth/logout ────────────────────────────────────────────────────────
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  if (token) await env.TERA_USERS.delete(`session:${token}`);
  return jsonOk({ ok: true });
}

// ── GET /kv-list ─────────────────────────────────────────────────────────────
async function handleKvList(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  const prefix = `data:${session.userId}:`;
  const list = await env.TERA_DATA.list({ prefix });
  const keys = list.keys.map(k => k.name.slice(prefix.length));
  return jsonOk({ keys });
}

// ── GET /kv/:key ─────────────────────────────────────────────────────────────
async function handleKvGet(request: Request, env: Env, key: string): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  const value = await env.TERA_DATA.get(`data:${session.userId}:${key}`);
  return jsonOk({ value });
}

// ── PUT /kv/:key ─────────────────────────────────────────────────────────────
async function handleKvPut(request: Request, env: Env, key: string): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  let body: { value?: string };
  try { body = await request.json() as typeof body; } catch { return jsonErr('JSON inválido'); }

  await env.TERA_DATA.put(`data:${session.userId}:${key}`, body.value ?? '');
  return jsonOk({ ok: true });
}

// ── DELETE /kv/:key ──────────────────────────────────────────────────────────
async function handleKvDelete(request: Request, env: Env, key: string): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  await env.TERA_DATA.delete(`data:${session.userId}:${key}`);
  return jsonOk({ ok: true });
}

// ── GET /user/apikey ─────────────────────────────────────────────────────────
async function handleApiKeyGet(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  const apiKey = await env.TERA_DATA.get(`apikey:${session.userId}`);
  return jsonOk({ configured: !!apiKey });
}

// ── PUT /user/apikey ─────────────────────────────────────────────────────────
async function handleApiKeyPut(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  let body: { apiKey?: string };
  try { body = await request.json() as typeof body; } catch { return jsonErr('JSON inválido'); }

  if (!body.apiKey) return jsonErr('apiKey é obrigatório');
  await env.TERA_DATA.put(`apikey:${session.userId}`, body.apiKey);
  return jsonOk({ ok: true });
}

// ── DELETE /user/apikey ──────────────────────────────────────────────────────
async function handleApiKeyDelete(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  await env.TERA_DATA.delete(`apikey:${session.userId}`);
  return jsonOk({ ok: true });
}

// ── POST /api/anthropic ──────────────────────────────────────────────────────
async function handleAnthropic(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  const session = await authenticate(token, env);
  if (!session) return jsonErr('Não autenticado', 401);

  const apiKey = await env.TERA_DATA.get(`apikey:${session.userId}`);
  if (!apiKey) return jsonErr('API key não configurada', 403);

  let body: unknown;
  try { body = await request.json(); } catch { return jsonErr('JSON inválido'); }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await upstream.text();
  return new Response(data, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Whitelist anti-SSRF ──────────────────────────────────────────────────────
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

// ── Rate limit ───────────────────────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = 20;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const slot = rateLimitMap.get(ip);
  if (!slot || now - slot.windowStart > WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (slot.count >= RATE_LIMIT) return false;
  slot.count++;
  return true;
}

// ── POST /fetch-proxy ────────────────────────────────────────────────────────
async function handleFetchProxy(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return jsonErr('Method not allowed', 405);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) return jsonErr('Rate limit exceeded', 429);

  let body: { url?: string };
  try { body = await request.json() as typeof body; } catch { return jsonErr('Invalid JSON body'); }

  if (!isUrlAllowed(body.url || '')) return jsonErr('URL not in allowed list', 403);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(body.url!, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Auditec-Curador/1.0 (Fiscal Compliance)', 'Accept': 'text/html,application/xhtml+xml' },
    });
    const html = await upstream.text();
    clearTimeout(timer);
    return corsResponse(JSON.stringify({ ok: true, html, status: upstream.status }), 200);
  } catch (err: unknown) {
    clearTimeout(timer);
    return corsResponse(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), 502);
  }
}

// ── Router principal ─────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Preflight CORS
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const path = url.pathname;

    if (path === '/auth/login'    && method === 'POST')   return handleLogin(request, env);
    if (path === '/auth/register' && method === 'POST')   return handleRegister(request, env);
    if (path === '/auth/me'       && method === 'GET')    return handleMe(request, env);
    if (path === '/auth/logout'   && method === 'POST')   return handleLogout(request, env);

    if (path === '/kv-list'       && method === 'GET')    return handleKvList(request, env);

    if (path.startsWith('/kv/')) {
      const key = decodeURIComponent(path.slice(4));
      if (method === 'GET')    return handleKvGet(request, env, key);
      if (method === 'PUT')    return handleKvPut(request, env, key);
      if (method === 'DELETE') return handleKvDelete(request, env, key);
    }

    if (path === '/user/apikey') {
      if (method === 'GET')    return handleApiKeyGet(request, env);
      if (method === 'PUT')    return handleApiKeyPut(request, env);
      if (method === 'DELETE') return handleApiKeyDelete(request, env);
    }

    if (path === '/api/anthropic' && method === 'POST')   return handleAnthropic(request, env);
    if (path === '/fetch-proxy')                          return handleFetchProxy(request);

    return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
  },
};
