'use strict';

/**
 * Parser: CGIBS — Notícias
 * URL: https://www.cgibs.gov.br/noticias
 *
 * Estrutura observada: SPA (React/Next.js).
 * Pode exibir "Exibindo 0 a 0 de 0 itens" (página vazia) ou cards com
 * comunicados, eventos, documentos. Editorias: Comunicados, Eventos,
 * Institucional, Transparência.
 *
 * Lógica: Puppeteer headless; detecta página vazia; coleta cards com data;
 * faz fetch secundário em links internos para extrair título/data completa.
 */

const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger = require('../utils/logger');

const NOME    = 'CGIBS';
const URL     = 'https://www.cgibs.gov.br/noticias';
const UA      = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT = 30_000;
const RETRIES = 2;

// Regex página vazia
const RE_VAZIO = /Exibindo\s+0\s+a\s+0\s+de\s+0\s+itens/i;

function gerarTags(texto) {
  const t = (texto || '').toUpperCase();
  const tags = ['IBS', 'CGIBS'];
  if (/\bCBS\b/.test(t))              tags.push('CBS');
  if (/\bIS\b|SELETIVO/.test(t))     tags.push('IS');
  if (/NOTA.T[EÉ]CNICA|NT\s*\d/.test(t)) tags.push('NT');
  if (/RTC|REFORMA/.test(t))          tags.push('RTC');
  if (/COMUNICADO/.test(t))           tags.push('Comunicado');
  if (/COMIT[EÊ]\s*GESTOR/.test(t))  tags.push('Comitê Gestor');
  if (/REGULAMENTO/.test(t))          tags.push('Regulamentação');
  if (/CARTILHA|MANUAL|GUIA/.test(t)) tags.push('Material');
  return [...new Set(tags)];
}

function truncar(texto, max) {
  if (!texto) return '';
  const p = texto.trim().replace(/\s+/g, ' ').split(' ');
  return p.length <= max ? p.join(' ') : p.slice(0, max).join(' ') + '…';
}

async function parseCgibs() {
  const consultadoEm = agora();
  logger.info(`[CGIBS] Iniciando coleta via Puppeteer`);
  const hj = hoje();

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    logger.error('[CGIBS] puppeteer não instalado: ' + e.message);
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: 'puppeteer não instalado' };
  }

  const puppeteerArgs = (process.env.PUPPETEER_ARGS || '--no-sandbox').split(' ').filter(Boolean);

  let browser;
  for (let t = 1; t <= RETRIES; t++) {
    try {
      browser = await puppeteer.launch({ headless: 'new', args: puppeteerArgs, timeout: TIMEOUT });
      break;
    } catch (err) {
      logger.warn(`[CGIBS] Browser launch tentativa ${t}: ${err.message}`);
      if (t === RETRIES) return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
      await sleep(2000);
    }
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setDefaultNavigationTimeout(TIMEOUT);
    await page.goto(URL, { waitUntil: 'networkidle2' });

    // Aguarda renderização SPA
    await page.waitForSelector('article, .card, h2, h3, [class*="noticia"], [class*="card"]', { timeout: 12_000 })
              .catch(() => {});
    await sleep(2000);

    const pageText = await page.evaluate(() => document.body.innerText || document.body.textContent || '');

    // Detecta página vazia
    if (RE_VAZIO.test(pageText)) {
      logger.info('[CGIBS] Página de notícias sem itens hoje (indicador "0 a 0 de 0")');
      return {
        nome: NOME, url: URL, consultadoEm,
        encontrouItensHoje: false, itens: [],
        observacoes: 'Página retornou "Exibindo 0 a 0 de 0 itens" — sem publicações hoje.',
      };
    }

    // Coleta cards/itens com data de hoje
    const candidatos = await page.evaluate((hjStr) => {
      const resultado = [];
      const seletores = ['article', '.card', '[class*="noticia"]', '[class*="card"]', 'li', '.item'];

      for (const sel of seletores) {
        const els = document.querySelectorAll(sel);
        if (!els.length) continue;

        for (const el of els) {
          const texto = el.innerText || el.textContent || '';
          // Verifica se contém dia, mês e ano de hoje
          const [d, m, y] = hjStr.split('/');
          if (!texto.includes(d) || !texto.includes(m) || !texto.includes(y)) continue;

          const linkEl = el.querySelector('a');
          const titulo = (
            el.querySelector('h1,h2,h3,h4,h5')?.innerText?.trim() ||
            linkEl?.innerText?.trim() ||
            texto.substring(0, 120)
          ).replace(/\s+/g, ' ').trim();

          if (!titulo || titulo.length < 5) continue;

          const href = linkEl?.getAttribute('href') || '';
          const urlCard = href.startsWith('http') ? href
                        : href ? 'https://www.cgibs.gov.br' + href
                        : 'https://www.cgibs.gov.br/noticias';

          // Tenta capturar editoria
          const editoria = (
            el.querySelector('[class*="editoria"], [class*="categoria"], [class*="tag"]')?.innerText?.trim() || ''
          );

          resultado.push({ titulo, href: urlCard, textoCard: texto, editoria });
        }

        if (resultado.length > 0) break;
      }
      return resultado;
    }, hj);

    const itens = [];
    for (const c of candidatos) {
      const dataStr = extrairData(c.textoCard) || hj;
      const resumo  = truncar(c.textoCard.replace(c.titulo, '').trim(), 50);
      const textoTags = c.titulo + ' ' + c.editoria + ' ' + resumo;

      itens.push({
        titulo: c.titulo,
        dataPublicacao: dataStr,
        url: c.href,
        resumoCurto: resumo,
        tags: gerarTags(textoTags),
        portalOrigem: NOME,
        tipoConteudo: c.editoria || 'notícia',
        confianca: dataStr !== hj ? 'media' : 'alta',
      });
    }

    const encontrouItensHoje = itens.length > 0;
    logger.info(`[CGIBS] ${itens.length} item(ns) do dia`);
    return {
      nome: NOME, url: URL, consultadoEm,
      encontrouItensHoje, itens,
      observacoes: encontrouItensHoje ? '' : 'Portal acessado com sucesso. Nenhum card com a data de hoje encontrado.',
    };
  } catch (err) {
    logger.error(`[CGIBS] Erro: ${err.message}`);
    return { nome: NOME, url: URL, consultadoEm, encontrouItensHoje: false, itens: [], erro: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseCgibs };
