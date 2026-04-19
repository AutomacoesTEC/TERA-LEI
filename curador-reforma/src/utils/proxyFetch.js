'use strict';

/**
 * proxyFetch — busca HTML via tera-proxy (Cloudflare Worker) com fallback direto.
 *
 * Motivação: dfe-portal.svrs.rs.gov.br bloqueia IPs de datacenter AWS/Azure.
 * O Worker roda em IPs Anycast Cloudflare que não são bloqueados.
 */

const axios  = require('axios');
const logger = require('./logger');

const PROXY_URL     = 'https://tera-proxy.naytributos.workers.dev/fetch-proxy';
const PROXY_TIMEOUT = 20_000;

const PROXY_DOMAINS = [
  'dfe-portal.svrs.rs.gov.br',
];

const OBS_BLOQUEIO =
  'Portal SVRS inacessível do ambiente CI (bloqueio de IP). ' +
  'Tentativa via proxy Cloudflare falhou. Monitoramento manual recomendado.';

function isBloqueioConhecido(err) {
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code)) return true;
  if (err.name === 'AbortError') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('timeout') || m.includes('econnreset') || m.includes('aborted');
}

/**
 * Retorna true se a URL pertence a um domínio que exige proxy.
 * @param {string} url
 * @returns {boolean}
 */
function isProxyNeeded(url) {
  try {
    const { hostname } = new URL(url);
    return PROXY_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

/**
 * Busca HTML de uma URL usando o tera-proxy como relay.
 * Fallback para axios direto se proxy falhar e fallbackDirect=true.
 *
 * @param {string} url              - URL alvo (deve estar na whitelist do Worker)
 * @param {boolean} fallbackDirect  - Se true, tenta fetch direto após falha do proxy
 * @returns {Promise<string>}       - HTML da página
 * @throws {Error}                  - Se ambos os métodos falharem
 */
async function proxyFetch(url, fallbackDirect = true) {
  // ── Tentativa via proxy ────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), PROXY_TIMEOUT);
  try {
    const res  = await fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
      signal:  controller.signal,
    });
    const json = await res.json();
    clearTimeout(timer);

    if (json.ok && typeof json.html === 'string') {
      logger.info(`[proxyFetch] ✓ via proxy (status ${json.status}): ${url.slice(0, 70)}`);
      return json.html;
    }

    throw new Error(`Proxy retornou ok:false — ${json.error || 'sem detalhe'}`);
  } catch (proxyErr) {
    clearTimeout(timer);
    logger.warn(`[proxyFetch] Proxy falhou: ${proxyErr.message}`);

    if (!fallbackDirect) {
      throw new Error(`Proxy indisponível e fallback desabilitado: ${proxyErr.message}`);
    }
  }

  // ── Fallback: fetch direto via axios ──────────────────────────────────────
  try {
    logger.info(`[proxyFetch] Tentando fetch direto: ${url.slice(0, 70)}`);
    const r = await axios.get(url, {
      headers: {
        'User-Agent': 'Auditec-Curador/1.0 (Fiscal Compliance)',
        Accept:       'text/html',
      },
      timeout: 15_000,
    });
    logger.info(`[proxyFetch] ✓ via direto: ${url.slice(0, 70)}`);
    return r.data;
  } catch (directErr) {
    throw new Error(
      `Proxy e fetch direto falharam. Proxy: ver log acima. Direto: ${directErr.message}`
    );
  }
}

module.exports = { proxyFetch, isProxyNeeded, isBloqueioConhecido, OBS_BLOQUEIO };
