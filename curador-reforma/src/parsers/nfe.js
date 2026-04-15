'use strict';

/**
 * Parser: NF-e — Notas Técnicas + Informes Técnicos
 * URLs:
 *   Notas Técnicas  : https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=
 *   Informes Técnicos: https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4=
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { hoje, isHoje, extrairData, truncarPalavras, agora } = require('../utils/date');
const logger  = require('../utils/logger');

const NOME     = 'Portal NF-e';
const BASE_URL = 'https://www.nfe.fazenda.gov.br';
const UA       = 'Auditec-Curador/1.0 (Fiscal Compliance)';
const TIMEOUT  = 30_000;
const RETRIES  = 2;

const FONTES = [
  {
    url: `${BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=`,
    tipo: 'nota técnica',
  },
  {
    url: `${BASE_URL}/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4=`,
    tipo: 'informe técnico',
  },
];

const RE_PUBLICADO = /[Pp]ublicad[ao]\s+em\s+(\d{2}\/\d{2}\/\d{4})/;
const RE_NT_NUM    = /(?:Nota\s+T[ée]cnica|Informe\s+T[ée]cnico|NT|IT)\s+([\d\.]+)/i;
const RE_VERSAO    = /v[e\.]?(?:rs[ãa]o\s*)?\.?(\d+[\.\d]*)/i;

async function fetchPage(url, tentativa = 1) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      timeout: TIMEOUT,
    });
    return r.data;
  } catch (err) {
    if (tentativa < RETRIES) {
      logger.warn(`[NF-e] Tentativa ${tentativa} falhou (${url}): ${err.message}. Retentando...`);
      await sleep(2000);
      return fetchPage(url, tentativa + 1);
    }
    throw err;
  }
}

function resolverUrl(href, baseUrl) {
  if (!href) return baseUrl;
  if (href.startsWith('http')) return href;
  try { return new URL(href, BASE_URL).href; } catch (_) { return baseUrl; }
}

function gerarTags(texto, tipo) {
  const t = (texto || '').toUpperCase();
  const tags = ['NF-e'];
  if (tipo === 'informe técnico') tags.push('Informe Técnico');
  if (/\bIBS\b/.test(t))             tags.push('IBS');
  if (/\bCBS\b/.test(t))             tags.push('CBS');
  if (/\bNT\b|NOTA.T[EÉ]CNICA/.test(t)) tags.push('NT');
  if (/SCHEMA|XSD|LEIAUTE/.test(t))  tags.push('Schema');
  if (/RTC|REFORMA/.test(t))         tags.push('RTC');
  if (/NFC-E|NFC_E/.test(t))         tags.push('NFC-e');
  return [...new Set(tags)];
}

async function parseFonte({ url, tipo }) {
  const hj    = hoje();
  const itens = [];

  try {
    const html = await fetchPage(url);
    const $    = cheerio.load(html);

    let vigentesEl = null;
    $('h2, h3, h4, strong, b, td, th, .titulo-secao').each((_, el) => {
      if (/documentos\s+vigentes/i.test($(el).text())) {
        vigentesEl = $(el);
        return false;
      }
    });

    const scope = vigentesEl ? vigentesEl.nextAll().addBack() : $('body');

    scope.find('a, tr').each((_, el) => {
      const tag = el.tagName || el.name;
      let textoEl, href, titulo;

      if (tag === 'a') {
        titulo  = $(el).text().trim();
        href    = $(el).attr('href') || '';
        textoEl = $(el).closest('li, tr, p, div, td').text().trim();
      } else {
        const link = $(el).find('a').first();
        titulo  = link.text().trim();
        href    = link.attr('href') || '';
        textoEl = $(el).text().trim();
      }

      if (!textoEl || textoEl.length < 5) return;
      if (/n[ãa]o\s+vigentes/i.test(textoEl)) return false;

      const matchPub = RE_PUBLICADO.exec(textoEl);
      const dataStr  = matchPub ? matchPub[1] : extrairData(textoEl);
      if (!dataStr || !isHoje(dataStr)) return;
      if (!titulo || titulo.length < 5) return;

      const ntMatch  = RE_NT_NUM.exec(textoEl);
      const verMatch = RE_VERSAO.exec(textoEl);
      const nt       = ntMatch  ? `${tipo === 'informe técnico' ? 'IT' : 'NT'} ${ntMatch[1]}` : '';
      const versao   = verMatch ? `v.${verMatch[1]}` : '';
      const tituloFinal = titulo || `${nt} ${versao}`.trim() || textoEl.substring(0, 100);

      itens.push({
        titulo: tituloFinal,
        dataPublicacao: dataStr,
        url: resolverUrl(href, url),
        resumoCurto: truncarPalavras(textoEl.replace(tituloFinal, '').trim(), 50),
        tags: gerarTags(textoEl, tipo),
        portalOrigem: NOME,
        tipoConteudo: tipo,
        confianca: matchPub ? 'alta' : 'media',
      });
    });

    // Fallback: regex no texto bruto
    if (itens.length === 0) {
      const texto = $('body').text().replace(/\s+/g, ' ');
      const re = tipo === 'informe técnico'
        ? /Informe\s+T[ée]cnico\s+([\d\.]+)[^\n]{0,200}?Publicad[ao]\s+em\s+(\d{2}\/\d{2}\/\d{4})/gi
        : /Nota\s+T[ée]cnica\s+([\d\.]+)[^\n]{0,200}?Publicad[ao]\s+em\s+(\d{2}\/\d{2}\/\d{4})/gi;
      let m;
      while ((m = re.exec(texto)) !== null) {
        if (!isHoje(m[2])) continue;
        itens.push({
          titulo: `${tipo === 'informe técnico' ? 'Informe Técnico' : 'Nota Técnica'} ${m[1]}`,
          dataPublicacao: m[2],
          url,
          resumoCurto: truncarPalavras(m[0], 50),
          tags: gerarTags(m[0], tipo),
          portalOrigem: NOME,
          tipoConteudo: tipo,
          confianca: 'media',
        });
      }
    }
  } catch (err) {
    logger.error(`[NF-e][${tipo}] Erro: ${err.message}`);
  }

  return itens;
}

async function parseNfe() {
  const consultadoEm = agora();
  logger.info(`[NF-e] Iniciando coleta (NTs + Informes Técnicos)`);

  const url = FONTES[0].url; // URL principal para metadados do portal
  const todosItens = [];

  for (const fonte of FONTES) {
    const itens = await parseFonte(fonte);
    logger.info(`[NF-e][${fonte.tipo}] ${itens.length} item(ns) do dia`);
    todosItens.push(...itens);
  }

  const encontrouItensHoje = todosItens.length > 0;
  return {
    nome: NOME, url, consultadoEm,
    encontrouItensHoje,
    itens: todosItens,
    observacoes: encontrouItensHoje ? '' : 'Nenhum documento publicado hoje (NTs e Informes Técnicos verificados).',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { parseNfe };
