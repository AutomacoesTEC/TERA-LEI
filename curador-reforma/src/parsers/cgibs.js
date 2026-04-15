'use strict';

/**
 * Parser: CGIBS — RSS Feed
 * URL: https://www.cgibs.gov.br/rss
 *
 * O site do CGIBS é uma SPA (React) que não renderiza conteúdo sem JS.
 * Solução: usar o feed RSS público disponível em /rss.
 */

const axios   = require('axios');
const { hoje, isHoje, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');

const NOME     = 'CGIBS';
const URL_RSS  = 'https://www.cgibs.gov.br/rss';
const URL_SITE = 'https://www.cgibs.gov.br/noticias';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 20_000;

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['IBS', 'CGIBS', 'Comitê Gestor'];
  if (/\bCBS\b/.test(t))                  tags.push('CBS');
  if (/\bIS\b|SELETIVO/.test(t))          tags.push('IS');
  if (/NOTA.T[EÉ]CNICA|NT\s*\d/.test(t)) tags.push('NT');
  if (/RTC|REFORMA/.test(t))              tags.push('RTC');
  if (/COMUNICADO/.test(t))               tags.push('Comunicado');
  if (/REGULAMENTO|RESOLUÇÃO/.test(t))    tags.push('Regulamentação');
  if (/CARTILHA|MANUAL|GUIA/.test(t))     tags.push('Material');
  if (/SPLIT\s*PAYMENT/.test(t))          tags.push('Split Payment');
  return [...new Set(tags)];
}

// Parse date from RSS dc:date (ISO 8601) → DD/MM/YYYY
function parseRssDate(dcDate) {
  if (!dcDate) return null;
  try {
    const d = new Date(dcDate.trim());
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  } catch (_) { return null; }
}

// Extract text from CDATA or plain XML text
function extractText(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}

async function parseCgibs() {
  const consultadoEm = agora();
  logger.info(`[CGIBS] Iniciando coleta via RSS`);

  try {
    const r = await axios.get(URL_RSS, {
      headers: { 'User-Agent': UA },
      timeout: TIMEOUT,
      responseType: 'text',
    });

    const xml = r.data;
    const items = [];
    const RE_ITEM = /<item>([\s\S]*?)<\/item>/gi;
    let m;

    while ((m = RE_ITEM.exec(xml)) !== null) {
      const block = m[1];

      const titleM   = block.match(/<title>([\s\S]*?)<\/title>/i);
      const linkM    = block.match(/<link>([\s\S]*?)<\/link>/i);
      const dateM    = block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i);
      const descM    = block.match(/<description>([\s\S]*?)<\/description>/i);

      const titulo   = extractText(titleM?.[1] || '');
      const link     = extractText(linkM?.[1]  || '');
      const dataStr  = parseRssDate(dateM?.[1]);
      const descRaw  = extractText(descM?.[1]  || '');

      if (!titulo || !dataStr) continue;
      if (!isHoje(dataStr)) continue;

      items.push({
        titulo,
        dataPublicacao: dataStr,
        url: link || URL_SITE,
        resumoCurto: truncarPalavras(descRaw, 50),
        tags: gerarTags(titulo + ' ' + descRaw),
        portalOrigem: NOME,
        tipoConteudo: 'comunicado',
        confianca: 'alta',
      });
    }

    const encontrouItensHoje = items.length > 0;
    logger.info(`[CGIBS] ${items.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL_SITE, consultadoEm,
      encontrouItensHoje, itens: items,
      observacoes: encontrouItensHoje ? '' : 'Nenhuma publicação do CGIBS hoje.',
    };

  } catch (err) {
    logger.error(`[CGIBS] Erro: ${err.message}`);
    return { nome: NOME, url: URL_SITE, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  }
}

module.exports = { parseCgibs };
