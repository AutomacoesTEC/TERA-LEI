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

/**
 * Verifica se uma URL já aponta para um documento direto (não uma lista).
 * Para portais Fazenda: exibirArquivo.aspx
 * Para SPED: /arquivo/show/ ou /arquivo/download/
 * Para outros: PDFs diretos
 */
function isLinkDireto(url) {
  if (!url) return false;
  return (
    /exibirArquivo\.aspx/i.test(url) ||
    /\/arquivo\/show\//i.test(url)    ||
    /\/arquivo\/download\//i.test(url)||
    /\.pdf(\?|#|$)/i.test(url)
  );
}

// ── Estratégias por portal ─────────────────────────────────────────────────
const ESTRATEGIAS = [
  {
    // NF-e, CT-e, MDF-e (fazenda), BP-e — Portal Fazenda
    // Link direto: exibirArquivo.aspx?conteudo=BASE64=
    test:    url => /fazenda\.gov\.br/i.test(url),
    base:    url => { try { return new URL(url).origin; } catch (_) { return ''; } },
    seletor: 'a[href*="exibirArquivo.aspx"]',
  },
  {
    // SPED — sped.rfb.gov.br
    // Link direto: /arquivo/show/ID ou /arquivo/download/ID
    test:    url => /sped\.rfb\.gov\.br/i.test(url),
    base:    ()  => 'http://sped.rfb.gov.br',
    seletor: 'a[href*="/arquivo/show/"], a[href*="/arquivo/download/"], a[href$=".pdf"]',
  },
  {
    // DFe-Portal SVRS (MDF-e SVRS, BP-e, NF-ABI)
    test:    url => /dfe-portal\.svrs\.rs\.gov\.br/i.test(url),
    base:    ()  => 'https://dfe-portal.svrs.rs.gov.br',
    seletor: 'a[href$=".pdf"], a[href*="download"], a[href*="/Noticia/"], a[href*="/Documento/"], a[onclick*="download_arquivo_estatico"]',
    resolver: ($, a, base) => {
      const onclick = $(a).attr('onclick') || '';
      const m = onclick.match(/download_arquivo_estatico\s*\(\s*'([^']+)'\s*,\s*(\d+)\s*,\s*'([^']+)'\s*\)/);
      if (m) {
        const [_, sistema, tipo, nome] = m;
        return `${base}/${sistema}/DownloadArquivoEstatico/?sistema=${sistema}&tipoArquivo=${tipo}&nomeArquivo=${nome}`;
      }
      return null;
    }
  },
  {
    // NFS-e gov.br
    test:    url => /gov\.br\/nfse/i.test(url),
    base:    ()  => 'https://www.gov.br',
    seletor: 'a[href$=".pdf"], a[href*="download"], .listing-item a, .tileItem a',
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
 * Fallback: primeiro da lista (mais recente em portais que listam em ordem DESC).
 */
function melhorCandidato(candidatos, termoBusca) {
  if (!candidatos.length) return null;

  const termoN = norm(termoBusca);
  if (!termoN) return candidatos[0];

  // 1. Match exato de substring (primeiros 30 chars do termo)
  const prefixo = termoN.slice(0, 30);
  let match = candidatos.find(c => norm(c.texto).includes(prefixo));
  if (match) return match;

  // 2. Palavras-chave relevantes do termo (len > 3), maioria deve estar presente
  const palavras = termoN.split(/\s+/).filter(p => p.length > 3);
  if (palavras.length) {
    const minMatch = Math.ceil(palavras.length / 2);
    match = candidatos.find(c => {
      const ct = norm(c.texto);
      return palavras.filter(p => ct.includes(p)).length >= minMatch;
    });
    if (match) return match;
  }

  // 3. Fallback: primeiro candidato (item mais recente na página)
  return candidatos[0];
}

/**
 * Resolve o link direto de um documento a partir de uma URL de lista.
 *
 * Fluxo:
 *   1. Se url já é link direto → retorna como está
 *   2. Se url não é lista conhecida → retorna como está (DOU, Planalto, etc.)
 *   3. Identifica estratégia pelo domínio
 *   4. Faz fetch da página de lista (timeout 10s)
 *   5. Extrai candidatos pelo seletor da estratégia
 *   6. Escolhe melhor candidato por semelhança com termoBusca
 *   7. Fallback: retorna listaUrl com linkResolvido=false
 *
 * @param {string} listaUrl   – URL da página (lista ou desconhecida)
 * @param {string} termoBusca – Título ou trecho do documento procurado
 * @returns {Promise<{ link: string, linkResolvido: boolean }>}
 */
async function resolverLinkDireto(listaUrl, termoBusca = '') {
  // 1. Já é link direto → retorna imediatamente
  if (isLinkDireto(listaUrl)) {
    return { link: listaUrl, linkResolvido: true };
  }

  // 2. Não é uma lista conhecida → usar como está (portais externos)
  if (!isListaUrl(listaUrl)) {
    return { link: listaUrl, linkResolvido: true };
  }

  // 3. Identifica estratégia
  const estrategia = ESTRATEGIAS.find(e => e.test(listaUrl));
  if (!estrategia) {
    logger.warn(`[linkResolver] Nenhuma estratégia para: ${listaUrl}`);
    return { link: listaUrl, linkResolvido: false };
  }

  // 4–6. Fetch + parse + seleção
  try {
    const { data: html } = await axios.get(listaUrl, {
      headers: { 'User-Agent': UA },
      timeout: TIMEOUT,
    });

    const $        = cheerio.load(html);
    const base     = estrategia.base(listaUrl);
    const candidatos = [];

    $(estrategia.seletor).each((_, a) => {
      const texto = $(a).text().trim();
      let url = null;

      if (estrategia.resolver) {
        url = estrategia.resolver($, a, base);
      }

      if (!url) {
        const href = $(a).attr('href') || '';
        if (href && !href.startsWith('#')) {
          url = href.startsWith('http') ? href
              : href.startsWith('/')     ? `${base}${href}`
              : `${base}/${href}`;
        }
      }

      if (url) candidatos.push({ texto, url });
    });

    if (!candidatos.length) {
      logger.warn(`[linkResolver] Nenhum link direto encontrado em: ${listaUrl.slice(0, 80)}`);
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

module.exports = { resolverLinkDireto, isListaUrl, isLinkDireto };
