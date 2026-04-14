'use strict';

/**
 * TERA Curador Reforma v2
 * Orquestrador principal — coleta publicações da Reforma Tributária do Consumo
 * em portais fiscais e envia resumo por e-mail.
 *
 * Uso: node curador-reforma.js
 *
 * Variáveis de ambiente (ver .env.example):
 *   EMAIL_USER      — conta Gmail do remetente
 *   EMAIL_PASS      — App Password do Gmail
 *   EMAIL_TO        — destinatário (padrão: tectributos.federal11@gmail.com)
 *   TIMEZONE        — fuso (padrão: America/Sao_Paulo)
 *   PUPPETEER_ARGS  — flags extras para o Chromium (CI: --no-sandbox)
 */

const path = require('path');
const fs   = require('fs');

// Carrega .env se existir (desenvolvimento local)
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .forEach(l => {
      const [k, ...v] = l.split('=');
      if (k && !process.env[k.trim()]) {
        process.env[k.trim()] = v.join('=').trim();
      }
    });
} catch (_) { /* .env opcional */ }

const { parseCte }     = require('./src/parsers/cte');
const { parseNfe }     = require('./src/parsers/nfe');
const { parseCgibs }   = require('./src/parsers/cgibs');
const { parseMdfe }    = require('./src/parsers/mdfe');
const { parseNfabi }   = require('./src/parsers/nfabi');
const { parseBpe }     = require('./src/parsers/bpe');
const { parseNfseRtc } = require('./src/parsers/nfseRtc');
const { enviarResumo } = require('./src/utils/email');
const logger           = require('./src/utils/logger');
const { hoje }         = require('./src/utils/date');

const DATA_DIR     = path.join(__dirname, 'data');
const PENDENTE_DIR = path.join(__dirname, 'pendente-publicacao');
const DELAY_MS     = 2_500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PARSERS = [
  { nome: 'Portal CT-e',   fn: parseCte     },
  { nome: 'Portal NF-e',   fn: parseNfe     },
  { nome: 'CGIBS',         fn: parseCgibs   },
  { nome: 'Portal MDF-e',  fn: parseMdfe    },
  { nome: 'Portal NF-ABI', fn: parseNfabi   },
  { nome: 'Portal BP-e',   fn: parseBpe     },
  { nome: 'NFS-e RTC',     fn: parseNfseRtc },
];

async function executar() {
  logger.info('══════════════════════════════════════════');
  logger.info('   TERA Curador Reforma v2 — iniciando   ');
  logger.info('══════════════════════════════════════════');

  const dataHoje = hoje();
  logger.info(`Data de verificação (BRT): ${dataHoje}`);

  // Garante existência dos diretórios de saída
  for (const dir of [DATA_DIR, PENDENTE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Diretório criado: ${dir}`);
    }
  }

  const portais   = [];
  let totalItens  = 0;

  for (let i = 0; i < PARSERS.length; i++) {
    const { nome, fn } = PARSERS[i];

    logger.info(`── [${i + 1}/${PARSERS.length}] ${nome}`);

    try {
      const resultado = await fn();
      portais.push(resultado);
      const qtd = (resultado.itens || []).length;
      totalItens += qtd;
      logger.info(`   ✓ ${nome}: ${qtd} item(ns)`);
    } catch (err) {
      // Um portal falhando NÃO impede os demais
      logger.error(`   ✗ ${nome} — erro inesperado: ${err.message}`);
      portais.push({ nome, url: '', itens: [], erro: err.message });
    }

    if (i < PARSERS.length - 1) {
      logger.info(`   ⏳ aguardando ${DELAY_MS}ms...`);
      await sleep(DELAY_MS);
    }
  }

  // ── Saída JSON ──────────────────────────────────────────────────────────
  const curadoria = {
    dataVerificacao: dataHoje,
    portais,
    totalItens,
  };

  const outputPath = path.join(DATA_DIR, 'reforma_curadoria.json');
  fs.writeFileSync(outputPath, JSON.stringify(curadoria, null, 2), 'utf8');
  logger.info(`JSON salvo em: ${outputPath}`);

  // ── Pendente-publicação (só quando há itens) ────────────────────────────
  if (totalItens > 0) {
    const dataSlug    = dataHoje.replace(/\//g, '-');
    const pendentePath = path.join(PENDENTE_DIR, `curadoria_${dataSlug}.json`);
    fs.writeFileSync(pendentePath, JSON.stringify(curadoria, null, 2), 'utf8');
    logger.info(`${totalItens} item(ns) salvos em pendente-publicacao/curadoria_${dataSlug}.json`);
  }

  // ── E-mail — SEMPRE enviado, mesmo com 0 itens ─────────────────────────
  logger.info('Enviando e-mail de resumo...');
  await enviarResumo(curadoria);

  logger.info('══════════════════════════════════════════');
  logger.info(`   Curadoria concluída: ${totalItens} item(ns) encontrado(s)   `);
  logger.info('══════════════════════════════════════════');
}

executar().catch(err => {
  logger.error(`Erro fatal: ${err.message}`);
  logger.error(err.stack || '');
  process.exit(1);
});
