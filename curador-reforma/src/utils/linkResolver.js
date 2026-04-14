'use strict';

/**
 * linkResolver — resolve URL de lista para link direto do documento.
 *
 * Portais que usam o padrão lista + arquivo:
 *   - nfe/cte/mdfe/bpe.fazenda.gov.br → exibirArquivo.aspx?conteudo=HASH=
 *   - sped.rfb.gov.br                 → /arquivo/show/ID ou /arquivo/download/ID
 *   - dfe-portal.svrs.rs.gov.br       → página de detalhe ou PDF
 *   - gov.br/nfse                     → PDF ou página de detalhe
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('./logger');

const UA      = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT = 10_000;

// ── Padrões que indicam URL de lista (precisa de resolução) ────────────────
const RE_LISTA = [
  /listaConteudo\.aspx/i,
  /informe\.aspx/i,
  /\/Noticias\/?$/i,
  /\/Documentos\/?$/i,
  /pasta\/show\//i,
  /pagina\/show\//i,
  /\/rtc\/?$/i,
];

function isListaUrl(url) {
  return RE_LISTA.some(r => r.test(url || ''));
}

// ── Estratégias por portal ─────────────────────────────────────────────────
const ESTRATEGIAS = [
  {
    // NF-e, CT-e, MDF-e, BP-e — Portal Fazenda
    test:     url => /fazenda\.gov\.br/i.test(url),
    base:     url => { try { return new URL(url).origin; } catch (_) { return ''; } },
    seletor:  'a[href*="exibirArquivo.aspx"]',
  },
  {
    // SPED — sped.rfb.gov.br
    test:     url => /sped\.rfb\.gov\.br/i.test(url),
    base:     ()  => 'http://sped.rfb.gov.br',
    seletor:  'a[href*="/arquivo/show/"], a[href*="/arquivo/download/"], a[href$=".pdf"]',
  },
  {
    // DFe-Portal SVRS (MDF-e, BP-e, NF-ABI)
    test:     url => /dfe-portal\.svrs\.rs\.gov\.br/i.test(url),
    base:     ()  => 'https://dfe-portal.svrs.rs.gov.br',
    seletor:  'a[href$=".pdf"], a[href*="download"], a[href*="/Noticia/"], a[href*="/Documento/"]',
  },
  {
    // NFS-e gov.br
    test:     url => /gov\.br\/nfse/i.test(url),
    base:     ()  => 'https://www.gov.br',
    seletor:  'a[href$=".pdf"], a[href*="download"], .listing-item a, .tileItem a',
  },
];

/**
 * Normaliza texto para comparação fuzzy.
 */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tenta encontrar o link mais relevante numa lista de candidatos
 * baseado na semelhança com o termoBusca.
 */
function melhorCandidato(candidatos, termoBusca) {
  if (!candidatos.length) return null;

  const termoN = norm(termoBusca);
  if (!termoN) return candidatos[0]; // sem hint → primeiro da lista (mais recente)

  // 1. Match exato de substring
  let match = candidatos.find(c => norm(c.texto).includes(termoN.slice(0, 25)));
  if (match) return match;

  // 2. Palavras-chave do termo em qualquer ordem
  const palavras = termoN.split(/\s+/).filter(p => p.length > 3);
  if (palavras.length) {
    match = candidatos.find(c => {
      const ct = norm(c.texto);
      return palavras.filter(p => ct.includes(p)).length >= Math.ceil(palavras.length / 2);
    });
    if (match) return match;
  }

  // 3. Fallback: primeiro candidato
  return candidatos[0];
}

/**
 * Resolve o link direto de um documento a partir de uma URL de lista.
 *
 * @param {string} listaUrl   – URL da página de listagem
 * @param {string} termoBusca – Título ou trecho do documento procurado
 * @returns {Promise<{ link: string, linkResolvido: boolean }>}
 */
async function resolverLinkDireto(listaUrl, termoBusca = '') {
  // Não é uma lista → já é link direto
  if (!isListaUrl(listaUrl)) {
    return { link: listaUrl, linkResolvido: true };
  }

  // Encontra estratégia para este portal
  const estrategia = ESTRATEGIAS.find(e => e.test(listaUrl));
  if (!estrategia) {
    logger.warn(`[linkResolver] Nenhuma estratégia para: ${listaUrl}`);
    return { link: listaUrl, linkResolvido: false };
  }

  try {
    const { data: html } = await axios.get(listaUrl, {
      headers: { 'User-Agent': UA },
      timeout: TIMEOUT,
    });

    const $   = cheerio.load(html);
    const base = estrategia.base(listaUrl);
    const candidatos = [];

    $(estrategia.seletor).each((_, a) => {
      const texto = $(a).text().trim();
      const href  = $(a).attr('href') || '';
      if (!href) return;
      const url = href.startsWith('http') ? href
                : href ? `${base}${href.startsWith('/') ? '' : '/'}${href}`
                : '';
      if (url) candidatos.push({ texto, url });
    });

    if (!candidatos.length) {
      logger.warn(`[linkResolver] Nenhum link direto em: ${listaUrl}`);
      return { link: listaUrl, linkResolvido: false };
    }

    const melhor = melhorCandidato(candidatos, termoBusca);
    logger.info(`[linkResolver] ✓ ${listaUrl.slice(0, 60)}… → ${melhor.url.slice(0, 80)}`);
    return { link: melhor.url, linkResolvido: true };

  } catch (err) {
    logger.warn(`[linkResolver] Falha (${listaUrl.slice(0, 60)}…): ${err.message}`);
    return { link: listaUrl, linkResolvido: false };
  }
}

module.exports = { resolverLinkDireto, isListaUrl };
