'use strict';

const { proxyFetch } = require('../utils/proxyFetch');
const { isHoje, extrairData } = require('../utils/date');
const logger = require('../utils/logger');

const PORTAL = 'SIJUT2 Normas RFB';

const BUSCAS = [
  { termo: 'IBS', label: 'IBS', url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action?tipoConsulta=formulario&termoBusca=IBS&tipoData=2&optOrdem=Publicacao_DESC' },
  { termo: 'CBS', label: 'CBS', url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action?tipoConsulta=formulario&termoBusca=CBS&tipoData=2&optOrdem=Publicacao_DESC' },
];

const BASE_URL = 'https://normas.receita.fazenda.gov.br';

function parseTabelaSijut2(html, termoBusca) {
  const itens = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const trContent = trMatch[1];
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trContent)) !== null) {
      const texto = tdMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      tds.push({ raw: tdMatch[1], texto });
    }
    if (tds.length < 5) continue;
    const dataTexto = tds[3].texto.trim();
    if (!isHoje(dataTexto)) continue;
    let link = '';
    const linkMatch = tds[1].raw.match(/href=["']([^"']+)["']/i);
    if (linkMatch) {
      link = linkMatch[1].startsWith('http') ? linkMatch[1] : BASE_URL + linkMatch[1];
    }
    const tipoAto = tds[0].texto;
    const numeroAto = tds[1].texto;
    const orgao = tds[2].texto;
    const ementa = tds[4].texto;
    itens.push({
      titulo: `${tipoAto} ${numeroAto} (${orgao}) — ${ementa}`.trim(),
      url: link,
      dataPublicacao: extrairData(dataTexto),
      tipoConteudo: tipoAto,
      portalOrigem: `${PORTAL} [${termoBusca}]`,
      tags: ['reforma tributária', termoBusca.toLowerCase(), tipoAto.toLowerCase()],
      resumoCurto: ementa.length > 200 ? ementa.substring(0, 200) + '…' : ementa,
      status: 'vigente',
    });
  }
  return itens;
}

async function coletarSijut2() {
  const todosItens = [];
  const inicio = Date.now();
  for (const busca of BUSCAS) {
    logger.info(`[SIJUT2][${busca.label}] Iniciando coleta`);
    try {
      const html = await proxyFetch(busca.url);
      if (!html || typeof html !== 'string') {
        logger.warn(`[SIJUT2][${busca.label}] Resposta inválida`);
        continue;
      }
      const itens = parseTabelaSijut2(html, busca.termo);
      logger.info(`[SIJUT2][${busca.label}] ${itens.length} item(ns) do dia`);
      todosItens.push(...itens);
    } catch (err) {
      logger.error(`[SIJUT2][${busca.label}] Erro: ${err.message}`);
    }
  }
  const ms = Date.now() - inicio;
  logger.info(`[SIJUT2] Total: ${todosItens.length} item(ns) (${ms}ms)`);
  return { portal: PORTAL, itens: todosItens, ms };
}

module.exports = { coletarSijut2 };
