/**
 * tera-proxy — Cloudflare Worker (versão completa)
 *
 * Rotas:
 *   POST   /auth/register        — cadastro com inviteCode
 *   POST   /auth/login           — login, retorna JWT
 *   POST   /auth/logout          — invalida sessão
 *   GET    /auth/me              — valida token, retorna userId + username
 *
 *   GET    /kv-list              — lista todas as chaves do usuário (TERA_DATA)
 *   GET    /kv/:key              — lê valor
 *   PUT    /kv/:key              — grava valor  { value: string }
 *   DELETE /kv/:key              — remove valor
 *
 *   GET    /user/apikey          — status da API Key Anthropic do usuário
 *   PUT    /user/apikey          — salva API Key  { apiKey: string }
 *   DELETE /user/apikey          — remove API Key
 *
 *   POST   /api/anthropic        — proxy para api.anthropic.com/v1/messages
 *
 *   POST   /fetch-proxy          — relay HTTP para portais DFe (sem JWT)
 */

export interface Env {
  TERA_USERS:   KVNamespace;   // userId → { username, passwordHash, salt }
  TERA_DATA:    KVNamespace;   // userId:key → value (dados de estudo)
  TERA_INVITES: KVNamespace;   // inviteCode → { used: bool, createdAt }
  JWT_SECRET:   string;        // secret para assinar tokens (env var)
}

// ── Constantes ──────────────────────────────────────────────────────────────
const TOKEN_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 dias
const PBKDF2_ITERS   = 100_000;
const SALT_BYTES     = 16;
const TOKEN_BYTES    = 32;

// ── CORS ─────────────────────────────────────────────────────────────────────
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg: string, status = 400): Response {
  return json({ ok: false, error: msg }, status);
}

// ── Crypto helpers ───────────────────────────────────────────────────────────
async function hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: string; salt: string }> {
  const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMat    = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    keyMat,
    256,
  );
  return {
    hash: bufToHex(new Uint8Array(derived)),
    salt: bufToHex(saltBytes),
  };
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function randomToken(): string {
  return bufToHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ── Session store (TERA_USERS: token → session JSON) ─────────────────────────
interface Session {
  userId:    string;
  username:  string;
  expiresAt: number;
}

async function createSession(env: Env, userId: string, username: string): Promise<string> {
  const token = randomToken();
  const session: Session = { userId, username, expiresAt: Date.now() + TOKEN_TTL_MS };
  // Guardamos token → session separadamente com TTL de 7 dias
  await env.TERA_USERS.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: Math.floor(TOKEN_TTL_MS / 1000),
  });
  return token;
}

async function getSession(env: Env, token: string): Promise<Session | null> {
  if (!token) return null;
  const raw = await env.TERA_USERS.get(`session:${token}`);
  if (!raw) return null;
  const s: Session = JSON.parse(raw);
  if (Date.now() > s.expiresAt) {
    await env.TERA_USERS.delete(`session:${token}`);
    return null;
  }
  return s;
}

async function deleteSession(env: Env, token: string): Promise<void> {
  await env.TERA_USERS.delete(`session:${token}`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function extractToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function requireAuth(request: Request, env: Env): Promise<Session | null> {
  const token = extractToken(request);
  return token ? getSession(env, token) : null;
}

// ── User store helpers ────────────────────────────────────────────────────────
interface UserRecord {
  userId:       string;
  username:     string;
  passwordHash: string;
  salt:         string;
  createdAt:    number;
}

async function findUserByUsername(env: Env, username: string): Promise<UserRecord | null> {
  const raw = await env.TERA_USERS.get(`user:${username.toLowerCase()}`);
  return raw ? (JSON.parse(raw) as UserRecord) : null;
}

async function saveUser(env: Env, user: UserRecord): Promise<void> {
  await env.TERA_USERS.put(`user:${user.username.toLowerCase()}`, JSON.stringify(user));
}

// ── Mascara a API key (sk-ant-api03-XXXXX…YYYYY) ─────────────────────────────
function maskApiKey(key: string): string {
  if (key.length < 20) return '***';
  return key.slice(0, 14) + '…' + key.slice(-4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /auth/register
async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string; inviteCode?: string };
  try { body = await request.json(); } catch { return err('JSON inválido'); }

  const { username, password, inviteCode } = body;
  if (!username?.trim() || !password?.trim() || !inviteCode?.trim()) {
    return err('username, password e inviteCode são obrigatórios');
  }
  if (username.length < 3 || username.length > 32) return err('Username deve ter 3-32 caracteres');
  if (password.length < 6) return err('Senha deve ter ao menos 6 caracteres');
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return err('Username: apenas letras, números, _ e -');

  // Verifica convite
  const invRaw = await env.TERA_INVITES.get(inviteCode.trim().toUpperCase());
  if (!invRaw) return err('Código de convite inválido', 403);
  const invite = JSON.parse(invRaw);
  if (invite.used) return err('Código de convite já utilizado', 403);

  // Verifica se username já existe
  if (await findUserByUsername(env, username)) return err('Username já cadastrado');

  // Cria usuário
  const { hash, salt } = await hashPassword(password);
  const userId = randomToken().slice(0, 16);
  const user: UserRecord = {
    userId,
    username: username.trim(),
    passwordHash: hash,
    salt,
    createdAt: Date.now(),
  };
  await saveUser(env, user);

  // Marca convite como usado
  await env.TERA_INVITES.put(
    inviteCode.trim().toUpperCase(),
    JSON.stringify({ ...invite, used: true, usedBy: username, usedAt: Date.now() }),
  );

  // Cria sessão
  const token = await createSession(env, userId, user.username);
  return json({ ok: true, token, userId, username: user.username }, 201);
}

// POST /auth/login
async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { username?: string; password?: string };
  try { body = await request.json(); } catch { return err('JSON inválido'); }

  const { username, password } = body;
  if (!username?.trim() || !password?.trim()) return err('username e password são obrigatórios');

  const user = await findUserByUsername(env, username.trim());
  if (!user) return err('Usuário ou senha incorretos', 401);

  const { hash } = await hashPassword(password, hexToBuf(user.salt));
  if (!timingSafeEqual(hash, user.passwordHash)) return err('Usuário ou senha incorretos', 401);

  const token = await createSession(env, user.userId, user.username);
  return json({ ok: true, token, userId: user.userId, username: user.username });
}

// POST /auth/logout
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request);
  if (token) await deleteSession(env, token);
  return json({ ok: true });
}

// GET /auth/me
async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);
  return json({ ok: true, userId: session.userId, username: session.username });
}

// ── KV endpoints (dados de estudo por usuário) ────────────────────────────────
// Chave no KV: userId:key
// GET /kv-list
async function handleKvList(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  const prefix = `${session.userId}:`;
  const list   = await env.TERA_DATA.list({ prefix });
  const keys   = list.keys.map(k => k.name.slice(prefix.length));
  return json({ ok: true, keys });
}

// GET /kv/:key
async function handleKvGet(request: Request, env: Env, key: string): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  const value = await env.TERA_DATA.get(`${session.userId}:${key}`);
  return json({ ok: true, key, value: value ?? null });
}

// PUT /kv/:key
async function handleKvPut(request: Request, env: Env, key: string): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  let body: { value?: string };
  try { body = await request.json(); } catch { return err('JSON inválido'); }
  if (body.value === undefined) return err('Campo "value" obrigatório');

  await env.TERA_DATA.put(`${session.userId}:${key}`, body.value);
  return json({ ok: true, key, value: body.value });
}

// DELETE /kv/:key
async function handleKvDelete(request: Request, env: Env, key: string): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  await env.TERA_DATA.delete(`${session.userId}:${key}`);
  return json({ ok: true, key, deleted: true });
}

// ── API Key Anthropic ─────────────────────────────────────────────────────────
// Guardada em TERA_DATA: userId:__apikey__

// GET /user/apikey
async function handleApiKeyGet(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  const key = await env.TERA_DATA.get(`${session.userId}:__apikey__`);
  if (!key) return json({ ok: true, configured: false });
  return json({ ok: true, configured: true, masked: maskApiKey(key) });
}

// PUT /user/apikey
async function handleApiKeyPut(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  let body: { apiKey?: string };
  try { body = await request.json(); } catch { return err('JSON inválido'); }

  const apiKey = body.apiKey?.trim() || '';
  if (!apiKey.startsWith('sk-ant-')) return err('Chave inválida — deve começar com sk-ant-');

  await env.TERA_DATA.put(`${session.userId}:__apikey__`, apiKey);
  return json({ ok: true, masked: maskApiKey(apiKey) });
}

// DELETE /user/apikey
async function handleApiKeyDelete(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  await env.TERA_DATA.delete(`${session.userId}:__apikey__`);
  return json({ ok: true, deleted: true });
}

// ── Proxy Anthropic ───────────────────────────────────────────────────────────
// POST /api/anthropic
async function handleAnthropicProxy(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  if (!session) return err('Não autenticado', 401);

  // Busca API key do usuário; fallback para env var global (se configurada)
  let apiKey = await env.TERA_DATA.get(`${session.userId}:__apikey__`);
  if (!apiKey) {
    // @ts-ignore — JWT_SECRET está no env, mas API_KEY pode estar também
    apiKey = (env as Record<string, string>).ANTHROPIC_API_KEY || '';
  }
  if (!apiKey) return err('API Key Anthropic não configurada para este usuário', 402);

  let body: unknown;
  try { body = await request.json(); } catch { return err('JSON inválido'); }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await upstream.json();
  return json(data, upstream.status);
}

// ── Fetch-proxy (sem autenticação — relay para portais DFe) ──────────────────
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
  } catch { return false; }
}

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

async function handleFetchProxy(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) return json({ ok: false, error: 'Rate limit exceeded' }, 429);

  let body: { url?: string };
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const targetUrl = body.url || '';
  if (!isUrlAllowed(targetUrl)) return json({ ok: false, error: 'URL not in allowed list' }, 403);

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
    return json({ ok: true, html, status: upstream.status });
  } catch (e: unknown) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: msg }, 502);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Preflight global
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;

    // ── Auth ─────────────────────────────────────────────────────────────────
    if (path === '/auth/register' && method === 'POST') return handleRegister(request, env);
    if (path === '/auth/login'    && method === 'POST') return handleLogin(request, env);
    if (path === '/auth/logout'   && method === 'POST') return handleLogout(request, env);
    if (path === '/auth/me'       && method === 'GET')  return handleMe(request, env);

    // ── KV ───────────────────────────────────────────────────────────────────
    if (path === '/kv-list' && method === 'GET') return handleKvList(request, env);

    const kvMatch = path.match(/^\/kv\/(.+)$/);
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]);
      if (method === 'GET')    return handleKvGet(request, env, key);
      if (method === 'PUT')    return handleKvPut(request, env, key);
      if (method === 'DELETE') return handleKvDelete(request, env, key);
    }

    // ── User API Key ──────────────────────────────────────────────────────────
    if (path === '/user/apikey') {
      if (method === 'GET')    return handleApiKeyGet(request, env);
      if (method === 'PUT')    return handleApiKeyPut(request, env);
      if (method === 'DELETE') return handleApiKeyDelete(request, env);
    }

    // ── Anthropic proxy ───────────────────────────────────────────────────────
    if (path === '/api/anthropic' && method === 'POST') return handleAnthropicProxy(request, env);

    // ── Fetch proxy (DFe) ─────────────────────────────────────────────────────
    if (path === '/fetch-proxy') return handleFetchProxy(request);

    return json({ error: 'Not found' }, 404);
  },
};
