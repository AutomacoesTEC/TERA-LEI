'use strict';

/**
 * Parser: CGIBS — Notícias
 * URL: https://www.cgibs.gov.br/noticias
 * Método: Puppeteer (SPA — React/Next.js)
 */

const { hoje, isHoje, truncarPalavras } = require('../utils/date');
const logger = require('../utils/logger');

const PORTAL = {
  nome: 'CGIBS',
  url:  'https://www.cgibs.gov.br/noticias',
};
const UA      = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT = 30_000;
const RETRIES = 2;

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['IBS', 'CGIBS'];
  if (t.match(/\bCBS\b/))                    tags.push('CBS');
  if (t.match(/\bIS\b|SELETIVO/))            tags.push('IS');
  if (t.match(/NOTA.T[EÉ]CNICA|NT\s*\d/))   tags.push('NT');
  if (t.match(/REFORMA|RTC/))                tags.push('RTC');
  if (t.match(/REGULAMENTO|REGULA/))         tags.push('Regulamentação');
  if (t.match(/COMIT[EÊ]\s*GESTOR/))        tags.push('Comitê Gestor');
  return [...new Set(tags)];
}

async function parseCgibs() {
  logger.info(`[CGIBS] Iniciando coleta via Puppeteer`);
  const hj = hoje();

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    logger.error('[CGIBS] puppeteer não instalado: ' + e.message);
    return { ...PORTAL, itens: [], erro: 'puppeteer não instalado' };
  }

  const puppeteerArgs = (process.env.PUPPETEER_ARGS || '--no-sandbox')
    .split(' ')
    .filter(Boolean);

  let browser;
  for (let tentativa = 1; tentativa <= RETRIES; tentativa++) {
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: puppeteerArgs,
        timeout: TIMEOUT,
      });
      break;
    } catch (err) {
      logger.warn(`[CGIBS] Tentativa ${tentativa} de iniciar browser falhou: ${err.message}`);
      if (tentativa === RETRIES) {
        return { ...PORTAL, itens: [], erro: err.message };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setDefaultNavigationTimeout(TIMEOUT);

    await page.goto(PORTAL.url, { waitUntil: 'networkidle2' });

    // Aguarda renderização do conteúdo SPA
    await page.waitForSelector('article, .noticia, .card, h2, h3', { timeout: 15_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const itens = await page.evaluate((hjStr) => {
      const resultado = [];

      // Seletores típicos de portais gov.br SPA (React)
      const seletores = [
        'article',
        '.noticia',
        '.card-noticia',
        '[class*="noticia"]',
        '[class*="card"]',
        'li',
      ];

      for (const seletor of seletores) {
        const elementos = document.querySelectorAll(seletor);
        if (elementos.length === 0) continue;

        for (const el of elementos) {
          const texto = el.innerText || el.textContent || '';
          if (!texto.includes(hjStr.split('/')[0]) ||
              !texto.includes(hjStr.split('/')[1]) ||
              !texto.includes(hjStr.split('/')[2])) continue;

          const linkEl = el.querySelector('a');
          const titulo = linkEl?.innerText?.trim() ||
                         el.querySelector('h1,h2,h3,h4')?.innerText?.trim() ||
                         texto.substring(0, 120).trim();

          if (!titulo || titulo.length < 5) continue;

          const href = linkEl?.getAttribute('href') || '';
          const url  = href.startsWith('http') ? href
                     : href ? 'https://www.cgibs.gov.br' + href
                     : 'https://www.cgibs.gov.br/noticias';

          resultado.push({ titulo, href: url, resumoRaw: texto });
        }

        if (resultado.length > 0) break;
      }

      return resultado;
    }, hj);

    const itensFinal = itens.map(item => ({
      titulo:         item.titulo,
      dataPublicacao: hj,
      url:            item.href,
      resumoCurto:    truncarPalavrasJS(item.resumoRaw || item.titulo, 50),
      tags:           gerarTags(item.titulo + ' ' + item.resumoRaw),
      tipoConteudo:   'Notícia',
      portalOrigem:   PORTAL.nome,
    }));

    logger.info(`[CGIBS] ${itensFinal.length} item(ns) do dia encontrado(s)`);
    return { ...PORTAL, itens: itensFinal };
  } catch (err) {
    logger.error(`[CGIBS] Erro: ${err.message}`);
    return { ...PORTAL, itens: [], erro: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Versão local (fora do contexto de browser) da truncarPalavras
function truncarPalavrasJS(texto, max) {
  if (!texto) return '';
  const palavras = texto.trim().split(/\s+/);
  if (palavras.length <= max) return texto.trim();
  return palavras.slice(0, max).join(' ') + '…';
}

module.exports = { parseCgibs };
