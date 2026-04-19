'use strict';

/**
 * Parser: BP-e Notícias — SVRS
 * URL: https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias
 *
 * Estrutura observada: notícias, comunicados, atualizações históricas BP-e,
 * implantação de versões, documentos técnicos, consultas públicas,
 * homologação/produção. Portal mistura notas novas com textos institucionais.
 *
 * Lógica: segmenta por blocos (strong/h + parágrafo), extrai data de cada bloco;
 * fallback com leitura de conteúdo completo de páginas internas quando a listagem
 * resumida não tiver data. Filtro estrito por dia.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');
const { proxyFetch } = require('../utils/proxyFetch');

const NOME     = 'Portal BP-e';
const URL      = 'https://dfe-portal.svrs.rs.gov.br/Bpe/Noticias';
const BASE_URL = 'https://dfe-portal.svrs.rs.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 15_000;
const RETRIES  = 1;

const OBS_BLOQUEIO =
  'Portal SVRS inacessível do ambiente CI (bloqueio de IP). ' +
  'Tentativa via proxy Cloudflare falhou. Monitoramento manual recomendado.';

function isBloqueioConhecido(err) {
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code)) return true;
  if (err.name === 'AbortError') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('timeout') || m.includes('econnreset') || m.includes('aborted');
}

async function fetchHtml(url, tentativa = 1) {
  try {
    return await proxyFetch(url, /* fallbackDirect= */ true);
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[BP-e] Tentativa ${tentativa}: ${err.message}. Retentando...`);
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
  const tags = ['BP-e'];
  if (/\bIBS\b/.test(t))              tags.push('IBS');
  if (/\bCBS\b/.test(t))              tags.push('CBS');
  if (/NOTA.T[EÉ]CNICA|NT\s*\d/.test(t)) tags.push('NT');
  if (/SCHEMA|XSD|LEIAUTE/.test(t))   tags.push('Schema');
  if (/RTC|REFORMA/.test(t))          tags.push('RTC');
  if (/HOMOLOGA/.test(t))             tags.push('Homologação');
  if (/PRODU[ÇC][ÃA]O/.test(t))       tags.push('Produção');
  if (/VALIDA[ÇC][ÃA]O|REGRA/.test(t)) tags.push('Validação');
  if (/CONSULTA\s*P[ÚU]BLICA/.test(t)) tags.push('Consulta Pública');
  if (/BILHETE|PASSAGEM/.test(t))      tags.push('Bilhete');
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

async function parseBpe() {
  const consultadoEm = agora();
  logger.info(`[BP-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetchHtml(URL);
    const $    = cheerio.load(html);
    const itens = [];
    const linksParaVerificar = [];

    // ── Estratégia 1: blocos strong/h com data inline ──
    $('strong, b, h3, h4, h5').each((_, el) => {
      const titulo = $(el).text().trim().replace(/\s+/g, ' ');
      if (!titulo || titulo.length < 8) return;
      if (/menu|navega|topo|rodap|portal/i.test(titulo)) return;

      // Monta texto do bloco (título + irmãos seguintes até próximo bloco)
      let textoBloco = titulo;
      let href = '';

      $(el).nextUntil('strong, b, h3, h4, h5, hr').each((_, irmao) => {
        textoBloco += ' ' + $(irmao).text();
        if (!href) {
          const a = $(irmao).is('a') ? $(irmao) : $(irmao).find('a').first();
          if (a.length) href = a.attr('href') || '';
        }
      });

      if (!href) {
        const a = $(el).find('a').first();
        if (a.length) href = a.attr('href') || '';
      }

      textoBloco = textoBloco.replace(/\s+/g, ' ').trim();
      const dataStr = extrairData(textoBloco);
      if (!dataStr || !isHoje(dataStr)) return;

      itens.push({
        titulo,
        dataPublicacao: dataStr,
        url: resolverUrl(href),
        resumoCurto: truncarPalavras(
          textoBloco.replace(titulo, '').replace(/\d{2}\/\d{2}\/\d{4}/g, '').trim(), 50
        ),
        tags: gerarTags(textoBloco),
        portalOrigem: NOME,
        tipoConteudo: 'notícia',
        confianca: 'alta',
      });
    });

    // ── Estratégia 2: linhas de tabela/lista com data de hoje ──
    if (itens.length === 0) {
      $('tr, li').each((_, el) => {
        const texto = $(el).text().replace(/\s+/g, ' ').trim();
        if (!isHoje(texto)) return;
        const link   = $(el).find('a').first();
        const titulo = link.text().trim() || texto.substring(0, 120);
        if (!titulo || titulo.length < 5) return;
        itens.push({
          titulo,
          dataPublicacao: extrairData(texto) || hj,
          url: resolverUrl(link.attr('href') || ''),
          resumoCurto: truncarPalavras(texto.replace(titulo, '').replace(/\d{2}\/\d{2}\/\d{4}/g, '').trim(), 50),
          tags: gerarTags(texto),
          portalOrigem: NOME,
          tipoConteudo: 'notícia',
          confianca: 'media',
        });
      });
    }

    // ── Estratégia 3: coleta links internos e verifica data na página de detalhe ──
    if (itens.length === 0) {
      $('a[href*="/Bpe/"]').each((_, a) => {
        const href  = $(a).attr('href') || '';
        const texto = $(a).text().trim();
        if (texto.length > 8 && !href.includes('Noticias')) {
          linksParaVerificar.push({ titulo: texto, url: resolverUrl(href) });
        }
      });

      for (const { titulo, url } of linksParaVerificar.slice(0, 5)) {
        const data = await extrairDataInterna(url);
        if (data && isHoje(data)) {
          itens.push({
            titulo,
            dataPublicacao: data,
            url,
            resumoCurto: truncarPalavras(titulo, 50),
            tags: gerarTags(titulo),
            portalOrigem: NOME,
            tipoConteudo: 'notícia',
            confianca: 'media',
          });
        }
      }
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[BP-e] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Portal verificado. Nenhuma notícia com a data de hoje encontrada.',
    };
  } catch (err) {
    logger.error(`[BP-e] Erro: ${err.message}`);
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

module.exports = { parseBpe };
