'use strict';

/**
 * Parser: CT-e Informes
 * URL: https://www.cte.fazenda.gov.br/portal/informe.aspx
 *
 * Estrutura observada: lista simples com data seguida de título:
 *   "29/08/2024 - Publicado schema da versão 1.04 da Nota Técnica 2024.002"
 *   "01/08/2024 - Publicada Nota Técnica DF-e 2024.001 - IBS/CBS"
 *
 * Lógica: regex de data DD/MM/YYYY no início do bloco, segmenta por blocos.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');

const NOME    = 'CT-e Informes';
const URL     = 'https://www.cte.fazenda.gov.br/portal/informe.aspx';
const UA      = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT = 30_000;
const RETRIES = 2;

// Regex que captura a linha de informe: "DD/MM/YYYY - <título>"
const RE_LINHA = /(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(.+)/g;

async function fetch(tentativa = 1) {
  try {
    const r = await axios.get(URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[CT-e] Tentativa ${tentativa} falhou: ${err.message}. Retentando...`);
      await sleep(2000);
      return fetch(tentativa + 1);
    }
    throw err;
  }
}

function gerarTags(titulo) {
  const t = (titulo || '').toUpperCase();
  const tags = ['CT-e'];
  if (/\bIBS\b/.test(t))                       tags.push('IBS');
  if (/\bCBS\b/.test(t))                       tags.push('CBS');
  if (/NOTA.T[EÉ]CNICA|NT[\s-]\d|NT\d/.test(t)) tags.push('NT');
  if (/SCHEMA|XSD|LEIAUTE/.test(t))            tags.push('Schema');
  if (/RTC|REFORMA/.test(t))                   tags.push('RTC');
  if (/VERS[ÃA]O|\bV\.\d/.test(t))             tags.push('Versão');
  if (/HOMOLOGA|PRODU[ÇC][ÃA]O/.test(t))       tags.push('Implantação');
  return [...new Set(tags)];
}

function avaliarConfianca(titulo, fonte) {
  // Bloco extraído do próprio portal = alta confiança
  if (titulo && fonte === 'bloco-regex') return 'alta';
  return 'media';
}

async function parseCte() {
  const consultadoEm = agora();
  logger.info(`[CT-e] Iniciando coleta`);
  const hj = hoje();

  try {
    const html = await fetch();
    const $    = cheerio.load(html);

    // Extrai todo o texto visível da página (menus excluídos quando possível)
    const conteudo = ($('#conteudo, .conteudo, main, #mainContent, .container').first().text()
      || $('body').text())
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ');

    const itens = [];
    let match;

    // Reinicia lastIndex para garantir execução limpa
    RE_LINHA.lastIndex = 0;

    while ((match = RE_LINHA.exec(conteudo)) !== null) {
      const dataStr = match[1];    // DD/MM/YYYY
      const titulo  = match[2].trim().replace(/\s+/g, ' ');

      if (!isHoje(dataStr)) continue;
      if (titulo.length < 5)  continue;

      // Monta URL: tentativa de encontrar link correspondente no HTML
      let urlItem = URL;
      $('a').each((_, a) => {
        const textoLink = $(a).text().trim();
        const href      = $(a).attr('href') || '';
        if (textoLink && titulo.toLowerCase().includes(textoLink.toLowerCase().slice(0, 20))) {
          urlItem = href.startsWith('http') ? href
                  : href ? new URL(href, URL).href
                  : URL;
          return false; // break
        }
      });

      itens.push({
        titulo,
        dataPublicacao: dataStr,
        url: urlItem,
        resumoCurto: truncarPalavras(titulo, 50),
        tags: gerarTags(titulo),
        portalOrigem: NOME,
        tipoConteudo: 'informe',
        confianca: avaliarConfianca(titulo, 'bloco-regex'),
      });
    }

    // Fallback: busca links cujo texto de pai contenha a data de hoje
    if (itens.length === 0) {
      $('a').each((_, a) => {
        const parent = $(a).closest('li, tr, p, div');
        const texto  = parent.text();
        if (!isHoje(texto)) return;
        const titulo = $(a).text().trim();
        if (!titulo || titulo.length < 5) return;
        const href   = $(a).attr('href') || '';
        const url    = href.startsWith('http') ? href : href ? new URL(href, URL).href : URL;
        itens.push({
          titulo,
          dataPublicacao: extrairData(texto) || hj,
          url,
          resumoCurto: truncarPalavras(texto.replace(titulo, '').trim(), 50),
          tags: gerarTags(titulo),
          portalOrigem: NOME,
          tipoConteudo: 'informe',
          confianca: 'media',
        });
      });
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[CT-e] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Nenhuma publicação encontrada para a data de hoje.',
    };
  } catch (err) {
    logger.error(`[CT-e] Erro: ${err.message}`);
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseCte };
