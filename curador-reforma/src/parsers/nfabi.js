'use strict';

/**
 * Parser: NF-ABI Documentos
 * URL: https://dfe-portal.svrs.rs.gov.br/Nfabi/Documentos
 *
 * Estrutura observada: documentos técnicos — manual de orientações,
 * anexo de leiaute, regras de validação, tabelas RTC (CST, cClassTrib,
 * crédito presumido). Tratado como documentação técnica, não notícia.
 *
 * Lógica: lista de documentos com título, versão, data de atualização
 * e link. Sem data explícita → tenta página interna. Filtro estrito por dia.
 * Preserva título técnico original (sensível a revisões).
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');
const { proxyFetch, isBloqueioConhecido, OBS_BLOQUEIO } = require('../utils/proxyFetch');

const NOME     = 'Portal NF-ABI';
const URL      = 'https://dfe-portal.svrs.rs.gov.br/Nfabi/Documentos';
const BASE_URL = 'https://dfe-portal.svrs.rs.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';

// Padrão de versão em títulos técnicos
const RE_VERSAO = /[Vv]ers[aã]o\s*([\d\.]+)|v([\d\.]+)/;

function fetchHtml(url) {
  return proxyFetch(url, /* fallbackDirect= */ true);
}

function resolverUrl(href) {
  if (!href) return URL;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return URL; }
}

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['NF-ABI'];
  if (/\bIBS\b/.test(t))              tags.push('IBS');
  if (/\bCBS\b/.test(t))              tags.push('CBS');
  if (/RTC|REFORMA/.test(t))          tags.push('RTC');
  if (/CST\b/.test(t))                tags.push('CST');
  if (/CCLASS|CLASSTRIB/.test(t))     tags.push('cClassTrib');
  if (/CR[ÉE]DITO\s*PRESUMIDO/.test(t)) tags.push('Crédito Presumido');
  if (/LEIAUTE|LAYOUT|ANEXO/.test(t)) tags.push('Leiaute');
  if (/MANUAL/.test(t))               tags.push('Manual');
  if (/REGRA.*VALIDA|VALIDA.*REGRA/.test(t)) tags.push('Validação');
  if (/NOTA.T[EÉ]CNICA|NT\s*\d/.test(t)) tags.push('NT');
  return [...new Set(tags)];
}

async function extrairDataInterna(urlInterna) {
  try {
    const html = await axios.get(urlInterna, {
      headers: { 'User-Agent': UA },
      timeout: 15_000,
    }).then(r => r.data);
    const $ = cheerio.load(html);
    return extrairData($('body').text());
  } catch (_) { return null; }
}

async function parseNfabi() {
  const consultadoEm = agora();
  logger.info(`[NF-ABI] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchHtml(URL);
    const $    = cheerio.load(html);
    const itens = [];
    const linksParaVerificar = [];

    // ── Estratégia 1: tabelas/listas com data de hoje visível ──
    const seletores = ['table tr', 'ul li', '.lista-documentos li', '.documento-item', 'article'];
    for (const sel of seletores) {
      $(sel).each((_, el) => {
        const texto = $(el).text().replace(/\s+/g, ' ').trim();
        if (!isHoje(texto)) return;

        const link  = $(el).find('a').first();
        // Preserva título técnico exato
        const tituloEl = link.text().trim() ||
                         $(el).find('strong, h3, h4, td').first().text().trim();
        if (!tituloEl || tituloEl.length < 5) return;

        const href    = link.attr('href') || '';
        const url     = resolverUrl(href);
        const dataStr = extrairData(texto) || hj;

        // Captura versão do título se houver
        const verMatch = RE_VERSAO.exec(texto);
        const versao   = verMatch ? ` ${verMatch[0]}` : '';

        itens.push({
          titulo: tituloEl + (versao && !tituloEl.includes(versao) ? versao : ''),
          dataPublicacao: dataStr,
          url,
          resumoCurto: truncarPalavras(
            texto.replace(tituloEl, '').replace(/\d{2}\/\d{2}\/\d{4}/g, '').trim(), 50
          ),
          tags: gerarTags(texto),
          portalOrigem: NOME,
          tipoConteudo: 'documentação técnica',
          confianca: 'alta',
        });
      });
      if (itens.length > 0) break;
    }

    // ── Estratégia 2: coleta todos os links da página e verifica data interna ──
    if (itens.length === 0) {
      $('a[href*="/Nfabi/"]').each((_, a) => {
        const href  = $(a).attr('href') || '';
        const texto = $(a).text().trim();
        if (texto.length > 8) {
          linksParaVerificar.push({ titulo: texto, url: resolverUrl(href) });
        }
      });

      for (const { titulo, url } of linksParaVerificar.slice(0, 8)) {
        const data = await extrairDataInterna(url);
        if (data && isHoje(data)) {
          itens.push({
            titulo,
            dataPublicacao: data,
            url,
            resumoCurto: truncarPalavras(titulo, 50),
            tags: gerarTags(titulo),
            portalOrigem: NOME,
            tipoConteudo: 'documentação técnica',
            confianca: 'media',
          });
        }
      }
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[NF-ABI] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Portal verificado. Nenhum documento atualizado hoje.',
    };
  } catch (err) {
    logger.error(`[NF-ABI] Erro: ${err.message}`);
    if (isBloqueioConhecido(err)) {
      return {
        nome: NOME, url: URL, consultadoEm,
        encontrouItensHoje: false, itens: [],
        portaisIndisponiveis: true,
        observacoes: OBS_BLOQUEIO,
      };
    }
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseNfabi };
