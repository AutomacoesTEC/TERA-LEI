'use strict';

/**
 * Parser: Portal NF-e — Notas Técnicas
 * URL: https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=
 * Método: cheerio (HTML estático com ASP.NET)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, truncarPalavras } = require('../utils/date');
const logger  = require('../utils/logger');

const PORTAL = {
  nome: 'Portal NF-e',
  url:  'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=',
};
const BASE_URL = 'https://www.nfe.fazenda.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 30_000;
const RETRIES  = 2;

async function fetchComRetry(url, tentativa = 1) {
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: TIMEOUT,
    });
    return resp.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[NF-e] Tentativa ${tentativa} falhou, retentando...`);
      await new Promise(r => setTimeout(r, 2000));
      return fetchComRetry(url, tentativa + 1);
    }
    throw err;
  }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['NF-e'];
  if (t.match(/\bIBS\b/))                    tags.push('IBS');
  if (t.match(/\bCBS\b/))                    tags.push('CBS');
  if (t.match(/NOTA.T[EÉ]CNICA|NT\s*\d/))   tags.push('NT');
  if (t.match(/SCHEMA|LEIAUTE|XSD/))         tags.push('Schema');
  if (t.match(/REFORMA|RTC/))                tags.push('RTC');
  if (t.match(/CT-E|CTE\b/))                tags.push('CT-e');
  if (t.match(/NFC-E|NFCE\b/))              tags.push('NFC-e');
  return [...new Set(tags)];
}

function resolverUrl(href) {
  if (!href) return PORTAL.url;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return PORTAL.url; }
}

async function parseNfe() {
  logger.info(`[NF-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchComRetry(PORTAL.url);
    const $    = cheerio.load(html);
    const itens = [];

    // O portal NF-e ASP.NET geralmente lista notas técnicas em tabela ou grid
    // Seletores típicos do portal: .grid, UpdatePanel, table.tabela
    const linhas = $('table tr, .gridRow, .gridAltRow, tr.GridRow, tr.GridAltRow');

    linhas.each((_, tr) => {
      const texto = $(tr).text();
      if (!isHoje(texto)) return;

      const link   = $(tr).find('a').first();
      const titulo = link.text().trim() || $(tr).find('td').first().text().trim();
      const href   = link.attr('href') || '';
      const url    = resolverUrl(href);

      if (!titulo || titulo.length < 5) return;

      // Tentar extrair descrição/resumo de outra célula da linha
      const celulas = $(tr).find('td');
      let resumoRaw = '';
      celulas.each((_, td) => {
        const t = $(td).text().trim();
        if (t && t !== titulo && !isHoje(t) && t.length > 20) resumoRaw = t;
      });

      itens.push({
        titulo,
        dataPublicacao: hj,
        url,
        resumoCurto: truncarPalavras(resumoRaw || titulo, 50),
        tags: gerarTags(titulo + ' ' + resumoRaw),
        tipoConteudo: 'Nota Técnica',
        portalOrigem: PORTAL.nome,
      });
    });

    // Fallback: busca por qualquer link/container que contenha a data de hoje
    if (itens.length === 0) {
      $('a').each((_, a) => {
        const parent = $(a).closest('li, p, div, td, tr');
        const texto  = parent.text();
        if (!isHoje(texto)) return;

        const titulo = $(a).text().trim();
        const href   = $(a).attr('href') || '';
        const url    = resolverUrl(href);
        if (!titulo || titulo.length < 5) return;

        itens.push({
          titulo,
          dataPublicacao: hj,
          url,
          resumoCurto: truncarPalavras(texto.replace(titulo, '').trim(), 50),
          tags: gerarTags(titulo),
          tipoConteudo: 'Nota Técnica',
          portalOrigem: PORTAL.nome,
        });
      });
    }

    logger.info(`[NF-e] ${itens.length} item(ns) do dia encontrado(s)`);
    return { ...PORTAL, itens };
  } catch (err) {
    logger.error(`[NF-e] Erro: ${err.message}`);
    return { ...PORTAL, itens: [], erro: err.message };
  }
}

module.exports = { parseNfe };
