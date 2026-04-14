'use strict';

/**
 * Parser: NF-e Documentos Vigentes (Notas Técnicas)
 * URL: https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=
 *
 * Estrutura observada: seções "Documentos vigentes" e "Documentos não vigentes"
 * com Notas Técnicas no padrão:
 *   "RT - Nota Técnica 2024.002 v.1.10 - IBS/CBS"
 *   "Nota Técnica 2025.002.v.1.00 - Publicada em 28/03/2025 - descrição..."
 *
 * Lógica: localiza seção "vigentes", extrai NT, versão, data de publicação,
 * descrição e link. Filtra data == hoje.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');

const NOME     = 'Portal NF-e';
const URL      = 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=';
const BASE_URL = 'https://www.nfe.fazenda.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 30_000;
const RETRIES  = 2;

// Padrão: "Publicada em DD/MM/YYYY" ou "Publicado em DD/MM/YYYY"
const RE_PUBLICADO = /[Pp]ublicad[ao]\s+em\s+(\d{2}\/\d{2}\/\d{4})/;
// Padrão NT: "Nota Técnica 2025.002" ou "NT 2025.002"
const RE_NT_NUM    = /Nota\s+T[ée]cnica\s+([\d\.]+)/i;
// Versão: "v.1.35" ou "v1.35" ou "versão 1.35"
const RE_VERSAO    = /v[e\.]?(?:rs[ãa]o\s*)?\.?(\d+[\.\d]*)/i;

async function fetch(tentativa = 1) {
  try {
    const r = await axios.get(URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[NF-e] Tentativa ${tentativa} falhou: ${err.message}. Retentando...`);
      await sleep(2000);
      return fetch(tentativa + 1);
    }
    throw err;
  }
}

function resolverUrl(href) {
  if (!href) return URL;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return URL; }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['NF-e'];
  if (/\bIBS\b/.test(t))            tags.push('IBS');
  if (/\bCBS\b/.test(t))            tags.push('CBS');
  if (/\bNT\b|NOTA.T[EÉ]CNICA/.test(t)) tags.push('NT');
  if (/SCHEMA|XSD|LEIAUTE/.test(t)) tags.push('Schema');
  if (/RTC|REFORMA/.test(t))        tags.push('RTC');
  if (/NFC-E|NFC_E/.test(t))        tags.push('NFC-e');
  if (/VERS[ÃA]O|\bV\.\d/.test(t)) tags.push('Versão');
  return [...new Set(tags)];
}

async function parseNfe() {
  const consultadoEm = agora();
  logger.info(`[NF-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetch();
    const $    = cheerio.load(html);
    const itens = [];

    // ── Estratégia 1: localizar seção "Documentos vigentes" e iterar seus links ──
    let vigentesEl = null;
    $('h2, h3, h4, strong, b, td, th, .titulo-secao').each((_, el) => {
      if (/documentos\s+vigentes/i.test($(el).text())) {
        vigentesEl = $(el);
        return false; // break
      }
    });

    // Coleta todos os links da seção vigentes (ou da página inteira como fallback)
    const scope = vigentesEl
      ? vigentesEl.nextAll().addBack()
      : $('body');

    scope.find('a, tr').each((_, el) => {
      const tag  = el.tagName || el.name;
      let textoEl, href, titulo;

      if (tag === 'a') {
        titulo  = $(el).text().trim();
        href    = $(el).attr('href') || '';
        const parent = $(el).closest('li, tr, p, div, td');
        textoEl = parent.text().trim();
      } else {
        // tr — procura link interno
        const link = $(el).find('a').first();
        titulo  = link.text().trim();
        href    = link.attr('href') || '';
        textoEl = $(el).text().trim();
      }

      if (!textoEl || textoEl.length < 5) return;

      // Detecta data via "Publicada em DD/MM/YYYY" ou qualquer DD/MM/YYYY no bloco
      const matchPub = RE_PUBLICADO.exec(textoEl);
      const dataStr  = matchPub ? matchPub[1] : extrairData(textoEl);

      if (!dataStr || !isHoje(dataStr)) return;

      // Para textos sem "Publicada em" mas com data de hoje inline → incluir
      if (!titulo || titulo.length < 5) return;

      // Parar se chegou na seção "não vigentes"
      if (/n[ãa]o\s+vigentes/i.test(textoEl)) return false;

      const ntMatch  = RE_NT_NUM.exec(textoEl);
      const verMatch = RE_VERSAO.exec(textoEl);
      const nt       = ntMatch  ? `NT ${ntMatch[1]}`  : '';
      const versao   = verMatch ? `v.${verMatch[1]}`  : '';

      const tituloFinal = titulo || `${nt} ${versao}`.trim() || textoEl.substring(0, 100);

      itens.push({
        titulo: tituloFinal,
        dataPublicacao: dataStr,
        url: resolverUrl(href),
        resumoCurto: truncarPalavras(textoEl.replace(tituloFinal, '').trim(), 50),
        tags: gerarTags(textoEl),
        portalOrigem: NOME,
        tipoConteudo: 'nota técnica',
        confianca: matchPub ? 'alta' : 'media',
      });
    });

    // ── Estratégia 2: texto bruto da página via regex ──
    if (itens.length === 0) {
      const texto = $('body').text().replace(/\s+/g, ' ');
      const RE_BLOCO = /Nota\s+T[ée]cnica\s+([\d\.]+)[^\n]{0,200}?Publicad[ao]\s+em\s+(\d{2}\/\d{2}\/\d{4})/gi;
      let m;
      while ((m = RE_BLOCO.exec(texto)) !== null) {
        const dataStr = m[2];
        if (!isHoje(dataStr)) continue;
        const trecho = m[0];
        itens.push({
          titulo: `Nota Técnica ${m[1]}`,
          dataPublicacao: dataStr,
          url: URL,
          resumoCurto: truncarPalavras(trecho, 50),
          tags: gerarTags(trecho),
          portalOrigem: NOME,
          tipoConteudo: 'nota técnica',
          confianca: 'media',
        });
      }
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[NF-e] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Nenhuma Nota Técnica publicada hoje na seção vigentes.',
    };
  } catch (err) {
    logger.error(`[NF-e] Erro: ${err.message}`);
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseNfe };
