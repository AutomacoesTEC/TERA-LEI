'use strict';

/**
 * TERA Curador Reforma v2 — Orquestrador Principal
 *
 * Coleta publicações da Reforma Tributária do Consumo (IBS/CBS) em 7 portais
 * fiscais, grava JSON estruturado e envia e-mail de resumo.
 *
 * Uso:  node curador-reforma.js
 * CI:   configurado via secrets no workflow curadoria_reforma_v2.yml
 *
 * Variáveis de ambiente:
 *   EMAIL_USER       Gmail remetente
 *   EMAIL_PASS       App Password Gmail
 *   EMAIL_TO         Destinatário (default: tectributos.federal11@gmail.com)
 *   TIMEZONE         Fuso (default: America/Sao_Paulo)
 *   PUPPETEER_ARGS   Flags Chromium (CI: --no-sandbox)
 */

const path = require('path');
const fs   = require('fs');

// ── Carrega .env local se existir (não obrigatório em CI) ────────────────────
try {
  const envPath = path.join(__dirname, '.env');
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const idx = l.indexOf('=');
      if (idx === -1) return;
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    });
} catch (_) { /* .env é opcional */ }

const { parseCte }     = require('./src/parsers/cte');
const { parseNfe }     = require('./src/parsers/nfe');
const { parseCgibs }   = require('./src/parsers/cgibs');
const { parseMdfe }    = require('./src/parsers/mdfe');
const { parseNfabi }   = require('./src/parsers/nfabi');
const { parseBpe }     = require('./src/parsers/bpe');
const { parseNfseRtc } = require('./src/parsers/nfseRtc');
const { enviarResumo } = require('./src/utils/email');
const logger           = require('./src/utils/logger');
const { hoje, agora }  = require('./src/utils/date');

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
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Diretório criado: ${dir}`);
    }
  }
}

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

  for (let i = 0; i < PARSERS.length; i++) {
    const { fn } = PARSERS[i];

    try {
      const resultado = await fn();
      portais.push(resultado);

      const qtd = (resultado.itens || []).length;
      totalItens += qtd;

      if (resultado.erro) {
        erros.push(`${resultado.nome}: ${resultado.erro}`);
        logger.warn(`[${i + 1}/${PARSERS.length}] ${resultado.nome} — ERRO: ${resultado.erro}`);
      } else {
        logger.info(`[${i + 1}/${PARSERS.length}] ${resultado.nome} — ${qtd} item(ns)`);
      }
    } catch (err) {
      // Um portal falhando NÃO impede os demais
      const nomeErr = fn.name.replace(/^parse/, '');
      logger.error(`[${i + 1}/${PARSERS.length}] ${nomeErr} — erro inesperado: ${err.message}`);
      erros.push(`${nomeErr}: ${err.message}`);
      portais.push({
        nome: nomeErr, url: '', consultadoEm: agora(),
        encontrouItensHoje: false, itens: [],
        erro: err.message,
      });
    }

    if (i < PARSERS.length - 1) {
      logger.info(`   ⏳ ${DELAY_MS}ms antes do próximo portal...`);
      await sleep(DELAY_MS);
    }
  }

  const totalPortaisVerificados = portais.length;
  const totalPortaisComItens    = portais.filter(p => p.encontrouItensHoje).length;
  const totalPortaisSemItens    = totalPortaisVerificados - totalPortaisComItens;

  // ── Monta payload JSON ────────────────────────────────────────────────────
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

  // ── Grava reforma_curadoria.json ──────────────────────────────────────────
  const outputPath = path.join(DATA_DIR, 'reforma_curadoria.json');
  fs.writeFileSync(outputPath, JSON.stringify(resultado, null, 2), 'utf8');
  logger.info(`JSON salvo: ${outputPath}`);

  // ── Grava pendente-publicacao se houver itens ─────────────────────────────
  if (totalItens > 0) {
    const slug     = dataVerificacao.replace(/\//g, '-');
    const pPath    = path.join(PENDENTE_DIR, `curadoria_${slug}.json`);
    fs.writeFileSync(pPath, JSON.stringify(resultado, null, 2), 'utf8');
    logger.info(`${totalItens} item(ns) → pendente-publicacao/curadoria_${slug}.json`);
  }

  // ── E-mail — SEMPRE enviado ───────────────────────────────────────────────
  logger.info('Enviando e-mail de resumo...');
  await enviarResumo(resultado);

  logger.info('══════════════════════════════════════════════════');
  logger.info(`  Concluído: ${totalItens} item(ns) · ${totalPortaisComItens}/${totalPortaisVerificados} portais com itens · ${erros.length} erro(s)`);
  logger.info('══════════════════════════════════════════════════');
}

executar().catch(err => {
  logger.error(`Erro fatal: ${err.message}`);
  logger.error(err.stack || '');
  process.exit(1);
});
