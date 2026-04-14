'use strict';

/**
 * Parser: Portal BP-e — Notícias
 * URL: https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias
 * Método: cheerio (plataforma DFe-Portal SVRS)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, truncarPalavras } = require('../utils/date');
const logger  = require('../utils/logger');

const PORTAL = {
  nome: 'Portal BP-e',
  url:  'https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias',
};
const BASE_URL = 'https://dfe-portal.svrs.rs.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 30_000;
const RETRIES  = 2;

async function fetchComRetry(url, tentativa = 1) {
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      timeout: TIMEOUT,
    });
    return resp.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[BP-e] Tentativa ${tentativa} falhou, retentando...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchComRetry(url, tentativa + 1);
    }
    throw err;
  }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['BP-e'];
  if (t.match(/\bIBS\b/))                    tags.push('IBS');
  if (t.match(/\bCBS\b/))                    tags.push('CBS');
  if (t.match(/NOTA.T[EÉ]CNICA|NT\s*\d/))   tags.push('NT');
  if (t.match(/SCHEMA|LEIAUTE|XSD/))         tags.push('Schema');
  if (t.match(/REFORMA|RTC/))                tags.push('RTC');
  if (t.match(/BILHETE|PASSAGEM/))           tags.push('Transporte');
  return [...new Set(tags)];
}

function resolverUrl(href) {
  if (!href) return PORTAL.url;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return PORTAL.url; }
}

async function parseBpe() {
  logger.info(`[BP-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchComRetry(PORTAL.url);
    const $    = cheerio.load(html);
    const itens = [];

    const seletores = [
      'ul.lista-noticias li',
      '.noticias-lista li',
      'table tr',
      '.noticia-item',
      'article',
      'li',
    ];

    for (const sel of seletores) {
      $(sel).each((_, el) => {
        const texto = $(el).text();
        if (!isHoje(texto)) return;

        const link   = $(el).find('a').first();
        const titulo = link.text().trim() ||
                       $(el).find('h3, h4, strong').first().text().trim() ||
                       texto.substring(0, 120).trim();
        const href   = link.attr('href') || '';
        const url    = resolverUrl(href);

        if (!titulo || titulo.length < 5) return;

        const resumoRaw = texto.replace(titulo, '').replace(/\d{2}\/\d{2}\/\d{4}/g, '').trim();
        itens.push({
          titulo,
          dataPublicacao: hj,
          url,
          resumoCurto: truncarPalavras(resumoRaw || titulo, 50),
          tags: gerarTags(titulo + ' ' + resumoRaw),
          tipoConteudo: 'Notícia',
          portalOrigem: PORTAL.nome,
        });
      });
      if (itens.length > 0) break;
    }

    logger.info(`[BP-e] ${itens.length} item(ns) do dia encontrado(s)`);
    return { ...PORTAL, itens };
  } catch (err) {
    logger.error(`[BP-e] Erro: ${err.message}`);
    return { ...PORTAL, itens: [], erro: err.message };
  }
}

module.exports = { parseBpe };
