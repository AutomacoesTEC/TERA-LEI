'use strict';

/**
 * TERA Curador Reforma v2 — Orquestrador Principal
 *
 * Coleta publicações da Reforma Tributária do Consumo (IBS/CBS) em 7 portais,
 * resolve links diretos dos documentos, adiciona campo status, grava JSON
 * e envia notificação via Telegram.
 *
 * Uso:  node curador-reforma.js
 * CI:   configurado via secrets no workflow curadoria_reforma_v2.yml
 *
 * Variáveis de ambiente:
 *   TELEGRAM_BOT_TOKEN  — token do bot Telegram
 *   TELEGRAM_CHAT_ID    — ID do chat/canal de destino
 *   TIMEZONE            — fuso (default: America/Sao_Paulo)
 */

const path = require('path');
const fs   = require('fs');

// ── Carrega .env local se existir (não obrigatório em CI) ────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const idx = l.indexOf('=');
      if (idx === -1) return;
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    });
} catch (_) {}

const { parseCte }       = require('./src/parsers/cte');
const { parseNfe }       = require('./src/parsers/nfe');
const { parseCgibs }     = require('./src/parsers/cgibs');
const { parseMdfe }      = require('./src/parsers/mdfe');
const { parseNfabi }     = require('./src/parsers/nfabi');
const { parseBpe }       = require('./src/parsers/bpe');
const { parseNfseRtc }   = require('./src/parsers/nfseRtc');
const { enviarTelegram } = require('./src/utils/telegram');
const { resolverLinkDireto, isListaUrl, isLinkDireto } = require('./src/utils/linkResolver');
const logger             = require('./src/utils/logger');
const { hoje, agora }    = require('./src/utils/date');

const DATA_DIR     = path.join(__dirname, 'data');
const PENDENTE_DIR = path.join(__dirname, 'pendente-publicacao');
const DELAY_MS     = 2_500;

const PARSERS = [
  { fn: parseCte     },
  { fn: parseNfe     },
  { fn: parseCgibs   },
  { fn: parseMdfe    },
  { fn: parseNfabi   },
  { fn: parseBpe     },
  { fn: parseNfseRtc },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function garantirDirs() {
  for (const dir of [DATA_DIR, PENDENTE_DIR]) {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  }
}

// ── Resolução de links diretos ─────────────────────────────────────────────
//
// Regras (por item):
//   1. Se item.url já é link direto (exibirArquivo.aspx, PDF, etc.)
//      → mantém, marca linkResolvido=true
//   2. Se item.url é uma lista ESPECÍFICA (diferente de portal.url)
//      → busca exibirArquivo.aspx NESSA lista específica (não no portal geral)
//   3. Se item.url é a própria portal.url ou está vazio
//      → busca exibirArquivo.aspx na página de lista do portal
//   4. Fallback: mantém URL de lista, linkResolvido=false
//
// linkLista é sempre preenchido com a URL de lista de origem.
async function resolverLinks(portais) {
  let resolvidos = 0;
  let fallbacks  = 0;

  for (const portal of portais) {
    for (const item of portal.itens || []) {

      // ── Caso 1: parser já encontrou link direto ──────────────────────────
      if (isLinkDireto(item.url)) {
        item.linkLista     = portal.url;
        item.linkResolvido = true;
        resolvidos++;
        continue;
      }

      // ── Determina URL da lista a buscar ───────────────────────────────────
      // Se o parser encontrou uma lista mais específica que o portal geral,
      // resolve a partir DELA (não do portal.url genérico).
      const fetchUrl = (item.url && isListaUrl(item.url)) ? item.url : portal.url;
      item.linkLista = fetchUrl;

      // ── Casos 2 e 3: resolver link direto ────────────────────────────────
      const { link, linkResolvido } = await resolverLinkDireto(fetchUrl, item.titulo);
      item.url           = link;
      item.linkResolvido = linkResolvido;
      linkResolvido ? resolvidos++ : fallbacks++;
    }
  }

  logger.info(`[linkResolver] ${resolvidos} resolvido(s) · ${fallbacks} fallback(s) para lista`);
}

// ── Campo status ─────────────────────────────────────────────────────────────
// Novos itens recebem status:"vigente".
// Detecção de versões superadas (status:"superada") é feita no Python de
// integração (curadoria_reforma_v2.yml), que tem acesso ao histórico completo.
function adicionarStatus(portais) {
  for (const portal of portais) {
    for (const item of portal.itens || []) {
      if (!item.status) item.status = 'vigente';
    }
  }
}

// ── Execução principal ────────────────────────────────────────────────────
async function executar() {
  logger.info('══════════════════════════════════════════════════');
  logger.info('  TERA Curador Reforma v2  —  Início de execução ');
  logger.info('══════════════════════════════════════════════════');

  const dataVerificacao = hoje();
  const dataExecucao    = agora();
  logger.info(`Data verificação (BRT): ${dataVerificacao}`);
  logger.info(`Data execução    (BRT): ${dataExecucao}`);

  garantirDirs();

  const portais  = [];
  const erros    = [];
  let totalItens = 0;

  // ── 1. Coleta ──────────────────────────────────────────────────────────
  for (let i = 0; i < PARSERS.length; i++) {
    const { fn } = PARSERS[i];

    try {
      const resultado = await fn();
      portais.push(resultado);
      const qtd = (resultado.itens || []).length;
      totalItens += qtd;

      if (resultado.erro) {
        erros.push(`${resultado.nome}: ${resultado.erro}`);
        logger.warn(`[${i+1}/${PARSERS.length}] ${resultado.nome} — ERRO: ${resultado.erro}`);
      } else {
        logger.info(`[${i+1}/${PARSERS.length}] ${resultado.nome} — ${qtd} item(ns)`);
      }
    } catch (err) {
      const nome = fn.name.replace(/^parse/, '');
      logger.error(`[${i+1}/${PARSERS.length}] ${nome} — erro inesperado: ${err.message}`);
      erros.push(`${nome}: ${err.message}`);
      portais.push({ nome, url: '', consultadoEm: agora(), encontrouItensHoje: false, itens: [], erro: err.message });
    }

    if (i < PARSERS.length - 1) {
      logger.info(`   ⏳ ${DELAY_MS}ms...`);
      await sleep(DELAY_MS);
    }
  }

  // ── 2. Pós-processamento: links diretos e status ───────────────────────
  if (totalItens > 0) {
    logger.info('Resolvendo links diretos dos documentos...');
    await resolverLinks(portais);
    adicionarStatus(portais);
  }

  // ── 3. Monta payload JSON ─────────────────────────────────────────────
  const totalPortaisVerificados = portais.length;
  const totalPortaisComItens    = portais.filter(p => p.encontrouItensHoje).length;
  const totalPortaisSemItens    = totalPortaisVerificados - totalPortaisComItens;

  const resultado = {
    dataVerificacao,
    dataExecucao,
    portais,
    totalItens,
    totalPortaisVerificados,
    totalPortaisComItens,
    totalPortaisSemItens,
    erros,
  };

  // ── 4. Grava JSON ─────────────────────────────────────────────────────
  const outputPath = path.join(DATA_DIR, 'reforma_curadoria.json');
  fs.writeFileSync(outputPath, JSON.stringify(resultado, null, 2), 'utf8');
  logger.info(`JSON salvo: ${outputPath}`);

  if (totalItens > 0) {
    const slug  = dataVerificacao.replace(/\//g, '-');
    const pPath = path.join(PENDENTE_DIR, `curadoria_${slug}.json`);
    fs.writeFileSync(pPath, JSON.stringify(resultado, null, 2), 'utf8');
    logger.info(`${totalItens} item(ns) → pendente-publicacao/curadoria_${slug}.json`);
  }

  // ── 5. Notificação Telegram ───────────────────────────────────────────
  logger.info('Enviando notificação Telegram...');
  await enviarTelegram(resultado);

  logger.info('══════════════════════════════════════════════════');
  logger.info(`  Concluído: ${totalItens} item(ns) · ${totalPortaisComItens}/${totalPortaisVerificados} portais · ${erros.length} erro(s)`);
  logger.info('══════════════════════════════════════════════════');
}

executar().catch(err => {
  logger.error(`Erro fatal: ${err.message}`);
  logger.error(err.stack || '');
  process.exit(1);
});
