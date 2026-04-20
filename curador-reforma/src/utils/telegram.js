'use strict';

/**
 * Telegram — Notificação via Bot API.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN  — token do bot (123456:ABC-DEF...)
 *   TELEGRAM_CHAT_ID    — ID do chat/canal de destino
 *
 * Falhas de envio são logadas mas NÃO lançam exceção (workflow não falha).
 */

const logger = require('./logger');

const TG_BASE = 'https://api.telegram.org';
const MAX_MSG = 4096; // limite de caracteres por mensagem do Telegram

// ── Helpers ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Divide texto longo em partes de até maxLen chars, quebrando em \n\n */
function dividir(texto, maxLen = MAX_MSG) {
  if (texto.length <= maxLen) return [texto];
  const partes = [];
  let restante = texto;
  while (restante.length > maxLen) {
    const corte = restante.lastIndexOf('\n\n', maxLen);
    const pos   = corte > 200 ? corte : maxLen;
    partes.push(restante.slice(0, pos).trimEnd());
    restante = restante.slice(pos).trimStart();
  }
  if (restante.trim()) partes.push(restante.trim());
  return partes;
}

// ── Montagem da mensagem ────────────────────────────────────────────────────

function montarMensagem(resultado) {
  const total         = resultado.totalItens || 0;
  const data          = resultado.dataVerificacao || '';
  const hora          = (resultado.dataExecucao  || '').slice(11, 16);
  const erros         = resultado.erros || [];
  const indisponiveis = resultado.portaisIndisponiveis || [];

  const linhaIndisponiveis = indisponiveis.length
    ? `\nℹ️ ${indisponiveis.length} portal(is) com acesso restrito em ambiente CI (SVRS)`
    : '';

  // ── Sem publicações ──────────────────────────────────────────────────────
  if (total === 0) {
    const linhaErros = erros.length
      ? `\n⚠️ ${erros.length} portal(is) com erro: ${erros.map(e => escHtml(e)).join(' | ')}`
      : '';
    return `✅ <b>TERA · Reforma em Dia</b> — Nenhuma publicação nova encontrada.${linhaErros}${linhaIndisponiveis}\n📅 <i>${escHtml(data)} às ${hora}</i>`;
  }

  // ── Com publicações ──────────────────────────────────────────────────────
  const todosItens = [];
  for (const portal of resultado.portais || []) {
    for (const item of portal.itens || []) {
      todosItens.push(item);
    }
  }

  const cabecalho = [
    `🟡 <b>TERA · Reforma em Dia</b>`,
    `📅 <i>${escHtml(data)} às ${hora}</i>`,
    '',
    `Encontrei <b>${total} nova(s) publicação(ões)</b>:`,
  ].join('\n');

  const blocos = todosItens.slice(0, 20).map(item => {
    const tags    = (item.tags || []).slice(0, 4).join(' · ');
    const portal  = item.portalOrigem || '';
    const link    = item.url || item.link || '';
    const status  = item.status === 'superada' ? ' ⚠️ <i>(versão superada)</i>' : '';

    return [
      `📌 <b>${escHtml(item.titulo)}</b>${status}`,
      tags   ? `🏷 ${escHtml(tags)}`                                          : '',
      portal ? `📂 ${escHtml(portal)}`                                        : '',
      link   ? `🔗 <a href="${link}">Acessar publicação</a>`                  : '',
      !item.linkResolvido ? `<i>(link da lista — verificar manualmente)</i>`  : '',
    ].filter(Boolean).join('\n');
  });

  const rodape = todosItens.length > 20
    ? `\n<i>… e mais ${todosItens.length - 20} publicação(ões)</i>` : '';

  const linhaErros = erros.length
    ? `\n\n⚠️ <b>${erros.length} portal(is) com erro:</b>\n${erros.map(e => `• ${escHtml(e)}`).join('\n')}`
    : '';

  return [cabecalho, '', blocos.join('\n\n'), rodape, linhaErros, linhaIndisponiveis].join('\n').trim();
}

// ── Envio ───────────────────────────────────────────────────────────────────

async function enviarParte(token, chatId, texto) {
  const url  = `${TG_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id:                chatId,
    text:                   texto,
    parse_mode:             'HTML',
    disable_web_page_preview: true,
  });
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await res.json();
    if (!json.ok) {
      logger.error(`[Telegram] Erro API: ${JSON.stringify(json.description || json)}`);
    } else {
      logger.info(`[Telegram] Mensagem enviada (id: ${json.result?.message_id})`);
    }
  } catch (err) {
    logger.error(`[Telegram] Falha de rede: ${err.message}`);
  }
}

/**
 * Envia o resumo da curadoria via Telegram.
 * Nunca lança exceção — erros são apenas logados.
 */
async function enviarTelegram(resultado) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn('[Telegram] TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID ausentes — notificação ignorada');
    return;
  }

  try {
    const texto  = montarMensagem(resultado);
    const partes = dividir(texto, MAX_MSG);
    logger.info(`[Telegram] Enviando ${partes.length} parte(s) para chat_id ${chatId}…`);
    for (const parte of partes) {
      await enviarParte(token, chatId, parte);
    }
  } catch (err) {
    // Nunca deixar o workflow falhar por causa da notificação
    logger.error(`[Telegram] Erro inesperado: ${err.message}`);
  }
}

module.exports = { enviarTelegram };
