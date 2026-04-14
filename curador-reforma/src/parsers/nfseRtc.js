'use strict';

/**
 * Parser: NFS-e — Documentação Técnica RTC
 * URL: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc
 *
 * Estrutura esperada: biblioteca de documentação técnica RTC para NFS-e.
 * Portal gov.br (Plone/Volto): estrutura variável — usa múltiplos seletores
 * tolerantes. Documentos: NTs, manuais, layouts, versões.
 * Abordagem conservadora: sem data explícita → navega página interna.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');

const NOME     = 'NFS-e RTC';
const URL      = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc';
const BASE_URL = 'https://www.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 30_000;
const RETRIES  = 2;

async function fetchHtml(url, tentativa = 1) {
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[NFS-e RTC] Tentativa ${tentativa}: ${err.message}. Retentando...`);
      await sleep(2000);
      return fetchHtml(url, tentativa + 1);
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
  const tags = ['NFS-e', 'RTC'];
  if (/\bIBS\b/.test(t))              tags.push('IBS');
  if (/\bCBS\b/.test(t))              tags.push('CBS');
  if (/NOTA.T[EÉ]CNICA|NT\s*\d/.test(t)) tags.push('NT');
  if (/SCHEMA|XSD|LEIAUTE|LAYOUT/.test(t)) tags.push('Schema');
  if (/MANUAL/.test(t))               tags.push('Manual');
  if (/SERVI[ÇC]O|ISS\b/.test(t))     tags.push('Serviços');
  if (/VERS[ÃA]O/.test(t))            tags.push('Versão');
  return [...new Set(tags)];
}

function tipoConteudo(texto) {
  const t = (texto || '').toUpperCase();
  if (/NOTA.T[EÉ]CNICA/.test(t)) return 'nota técnica';
  if (/MANUAL/.test(t))          return 'manual';
  if (/LEIAUTE|LAYOUT/.test(t))  return 'leiaute';
  if (/REGULAMENTO/.test(t))     return 'normativo';
  return 'documentação técnica';
}

async function extrairDataInterna(urlInterna) {
  try {
    const html = await axios.get(urlInterna, {
      headers: { 'User-Agent': UA },
      timeout: 15_000,
    }).then(r => r.data);
    const $ = cheerio.load(html);
    // gov.br: data em <span class="documentPublished"> ou metadados
    const meta = $('[class*="Published"], [class*="Modified"], time').first().text();
    return extrairData(meta) || extrairData($('body').text());
  } catch (_) { return null; }
}

async function parseNfseRtc() {
  const consultadoEm = agora();
  logger.info(`[NFS-e RTC] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchHtml(URL);
    const $    = cheerio.load(html);
    const itens = [];
    const linksParaVerificar = [];

    // ── Seletores típicos do Plone/Volto gov.br ──
    const seletores = [
      '.listing-item',
      '.tileItem',
      'article',
      '.summary',
      '.item',
      'table tr',
      'li',
    ];

    for (const sel of seletores) {
      $(sel).each((_, el) => {
        const texto = $(el).text().replace(/\s+/g, ' ').trim();

        // Data explícita no bloco
        const dataStr = extrairData(texto);
        if (dataStr && isHoje(dataStr)) {
          const link   = $(el).find('a').first();
          const titulo = (
            $(el).find('.tileHeadline, h2, h3, h4, strong').first().text().trim() ||
            link.text().trim() ||
            texto.substring(0, 120)
          ).replace(/\s+/g, ' ');
          if (!titulo || titulo.length < 5) return;

          const href = link.attr('href') || '';
          const descr = $(el).find('.tileBody, .description, p').first().text().trim();

          itens.push({
            titulo,
            dataPublicacao: dataStr,
            url: resolverUrl(href),
            resumoCurto: truncarPalavras(descr || texto.replace(titulo, '').trim(), 50),
            tags: gerarTags(titulo + ' ' + descr),
            portalOrigem: NOME,
            tipoConteudo: tipoConteudo(titulo),
            confianca: 'alta',
          });
          return; // próximo elemento
        }

        // Sem data no bloco → coleta link para verificação posterior
        const link  = $(el).find('a').first();
        const href  = link.attr('href') || '';
        const titulo = link.text().trim();
        if (href && titulo && titulo.length > 8 && /rtc|nfs|nt\s*\d|nota.t[eé]/i.test(titulo)) {
          linksParaVerificar.push({ titulo, url: resolverUrl(href) });
        }
      });

      if (itens.length > 0) break;
    }

    // ── Fallback: verifica data internamente para links candidatos ──
    if (itens.length === 0) {
      // Também coleta todos links da página com termos relevantes
      $('a').each((_, a) => {
        const href  = $(a).attr('href') || '';
        const texto = $(a).text().trim();
        if (texto.length > 8 && /rtc|nfs|nt\s*\d|nota.t[eé]|manual|leiaute/i.test(texto)) {
          linksParaVerificar.push({ titulo: texto, url: resolverUrl(href) });
        }
      });

      // Remove duplicatas
      const vistos = new Set();
      const uniq = linksParaVerificar.filter(l => {
        if (vistos.has(l.url)) return false;
        vistos.add(l.url);
        return true;
      });

      for (const { titulo, url } of uniq.slice(0, 6)) {
        const data = await extrairDataInterna(url);
        if (data && isHoje(data)) {
          itens.push({
            titulo,
            dataPublicacao: data,
            url,
            resumoCurto: truncarPalavras(titulo, 50),
            tags: gerarTags(titulo),
            portalOrigem: NOME,
            tipoConteudo: tipoConteudo(titulo),
            confianca: 'media',
          });
        }
      }
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[NFS-e RTC] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Portal verificado. Nenhum documento RTC publicado hoje.',
    };
  } catch (err) {
    logger.error(`[NFS-e RTC] Erro: ${err.message}`);
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseNfseRtc };
