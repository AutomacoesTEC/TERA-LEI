'use strict';

/**
 * Parser: Portal CT-e — Informes
 * URL: https://www.cte.fazenda.gov.br/portal/informe.aspx
 * Método: cheerio (HTML estático)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, truncarPalavras } = require('../utils/date');
const logger  = require('../utils/logger');

const PORTAL = {
  nome: 'Portal CT-e',
  url:  'https://www.cte.fazenda.gov.br/portal/informe.aspx',
};
const UA      = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT = 30_000;
const RETRIES = 2;

async function fetchComRetry(url, tentativa = 1) {
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: TIMEOUT,
    });
    return resp.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[CT-e] Tentativa ${tentativa} falhou, retentando...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchComRetry(url, tentativa + 1);
    }
    throw err;
  }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['CT-e'];
  if (t.match(/\bIBS\b/))                    tags.push('IBS');
  if (t.match(/\bCBS\b/))                    tags.push('CBS');
  if (t.match(/NOTA.T[EÉ]CNICA|NT\s*\d/))   tags.push('NT');
  if (t.match(/SCHEMA|LEIAUTE|XSD/))         tags.push('Schema');
  if (t.match(/REFORMA|RTC/))                tags.push('RTC');
  if (t.match(/NF-E|NF_E\b/))               tags.push('NF-e');
  return [...new Set(tags)];
}

function resolverUrl(href) {
  if (!href) return PORTAL.url;
  if (href.startsWith('http')) return href;
  try { return new URL(href, PORTAL.url).href; } catch (_) { return PORTAL.url; }
}

async function parseCte() {
  logger.info(`[CT-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchComRetry(PORTAL.url);
    const $ = cheerio.load(html);
    const itens = [];

    // O portal CT-e usa tabelas ou listas de informes; tentamos múltiplos seletores
    const candidatos = [];

    // Tentativa 1: linhas de tabela com data
    $('table tr').each((_, tr) => {
      const texto = $(tr).text();
      if (isHoje(texto)) candidatos.push($(tr));
    });

    // Tentativa 2: itens de lista/div com data
    if (candidatos.length === 0) {
      $('li, .informe, .item-noticia, .list-item, p').each((_, el) => {
        const texto = $(el).text();
        if (isHoje(texto)) candidatos.push($(el));
      });
    }

    // Tentativa 3: qualquer elemento que contenha a data de hoje
    if (candidatos.length === 0) {
      $('*').each((_, el) => {
        const texto = $(el).text();
        if (isHoje(texto) && $(el).find('a').length > 0) {
          candidatos.push($(el));
        }
      });
    }

    for (const el of candidatos) {
      const link    = el.find('a').first();
      const titulo  = link.text().trim() || el.text().trim().substring(0, 120);
      const href    = link.attr('href') || '';
      const url     = resolverUrl(href);
      const textoEl = el.text().replace(titulo, '').trim();
      const resumo  = truncarPalavras(textoEl || titulo, 50);

      if (!titulo || titulo.length < 5) continue;

      itens.push({
        titulo,
        dataPublicacao: hj,
        url,
        resumoCurto: resumo,
        tags: gerarTags(titulo + ' ' + resumo),
        tipoConteudo: 'Informe',
        portalOrigem: PORTAL.nome,
      });
    }

    logger.info(`[CT-e] ${itens.length} item(ns) do dia encontrado(s)`);
    return { ...PORTAL, itens };
  } catch (err) {
    logger.error(`[CT-e] Erro: ${err.message}`);
    return { ...PORTAL, itens: [], erro: err.message };
  }
}

module.exports = { parseCte };
