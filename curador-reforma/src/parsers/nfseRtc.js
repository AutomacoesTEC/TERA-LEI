'use strict';

/**
 * Parser: NFS-e — Documentação Técnica RTC
 * URL: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc
 * Método: cheerio (Portal Gov.br)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, truncarPalavras } = require('../utils/date');
const logger  = require('../utils/logger');

const PORTAL = {
  nome: 'NFS-e RTC',
  url:  'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc',
};
const BASE_URL = 'https://www.gov.br';
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
      logger.warn(`[NFS-e RTC] Tentativa ${tentativa} falhou, retentando...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchComRetry(url, tentativa + 1);
    }
    throw err;
  }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['NFS-e', 'RTC'];
  if (t.match(/\bIBS\b/))                    tags.push('IBS');
  if (t.match(/\bCBS\b/))                    tags.push('CBS');
  if (t.match(/NOTA.T[EÉ]CNICA|NT\s*\d/))   tags.push('NT');
  if (t.match(/SCHEMA|LEIAUTE|XSD/))         tags.push('Schema');
  if (t.match(/REFORMA/))                    tags.push('RTC');
  if (t.match(/SERVI[ÇC]O|ISS/))            tags.push('ISS');
  return [...new Set(tags)];
}

function resolverUrl(href) {
  if (!href) return PORTAL.url;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return PORTAL.url; }
}

async function parseNfseRtc() {
  logger.info(`[NFS-e RTC] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchComRetry(PORTAL.url);
    const $    = cheerio.load(html);
    const itens = [];

    // Portal gov.br — conteúdo em Plone/Volto; estrutura típica:
    // .listing-item, .tileItem, article, table tr
    const seletores = [
      '.listing-item',
      '.tileItem',
      'article',
      'table tr',
      '.summary',
      'li',
    ];

    for (const sel of seletores) {
      $(sel).each((_, el) => {
        const texto = $(el).text();
        if (!isHoje(texto)) return;

        const link   = $(el).find('a').first();
        const titulo = link.text().trim() ||
                       $(el).find('h2, h3, h4, .tileHeadline').first().text().trim() ||
                       texto.substring(0, 120).trim();
        const href   = link.attr('href') || '';
        const url    = resolverUrl(href);

        if (!titulo || titulo.length < 5) return;

        const resumoRaw = $(el).find('.tileBody, .description, p').first().text().trim() ||
                          texto.replace(titulo, '').trim();
        itens.push({
          titulo,
          dataPublicacao: hj,
          url,
          resumoCurto: truncarPalavras(resumoRaw || titulo, 50),
          tags: gerarTags(titulo + ' ' + resumoRaw),
          tipoConteudo: 'Documentação Técnica',
          portalOrigem: PORTAL.nome,
        });
      });
      if (itens.length > 0) break;
    }

    // Fallback: busca por qualquer link com data de hoje na página inteira
    if (itens.length === 0) {
      $('a').each((_, a) => {
        const parent = $(a).closest('tr, li, div, article, p');
        if (!isHoje(parent.text())) return;
        const titulo = $(a).text().trim();
        if (!titulo || titulo.length < 5) return;
        const url = resolverUrl($(a).attr('href') || '');
        itens.push({
          titulo,
          dataPublicacao: hj,
          url,
          resumoCurto: truncarPalavras(parent.text().replace(titulo, '').trim(), 50),
          tags: gerarTags(titulo),
          tipoConteudo: 'Documentação Técnica',
          portalOrigem: PORTAL.nome,
        });
      });
    }

    logger.info(`[NFS-e RTC] ${itens.length} item(ns) do dia encontrado(s)`);
    return { ...PORTAL, itens };
  } catch (err) {
    logger.error(`[NFS-e RTC] Erro: ${err.message}`);
    return { ...PORTAL, itens: [], erro: err.message };
  }
}

module.exports = { parseNfseRtc };
