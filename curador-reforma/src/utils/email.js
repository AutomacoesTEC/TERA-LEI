'use strict';

/**
 * Envia e-mail de resumo da curadoria via Gmail App Password (Nodemailer).
 * SEMPRE enviado — mesmo com 0 itens encontrados.
 */

const nodemailer = require('nodemailer');
const logger     = require('./logger');

async function enviarResumo(resultado) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO || 'tectributos.federal11@gmail.com';

  if (!user || !pass) {
    logger.warn('EMAIL_USER ou EMAIL_PASS ausentes — e-mail não enviado');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  const total   = resultado.totalItens || 0;
  const data    = resultado.dataVerificacao || '';
  const exec    = resultado.dataExecucao || '';
  const erros   = resultado.erros || [];

  // ── Seção por portal ──────────────────────────────────────────────────────
  let portaisHtml = '';
  for (const p of resultado.portais || []) {
    const itens  = p.itens || [];
    const temItem = itens.length > 0;
    const cor    = temItem ? '#1a237e' : (p.erro ? '#b71c1c' : '#757575');
    const badge  = temItem
      ? `<span style="background:#1a237e;color:#fff;padding:2px 8px;border-radius:10px;font-size:.75em">${itens.length} item(ns)</span>`
      : (p.erro
          ? `<span style="background:#ffcdd2;color:#b71c1c;padding:2px 8px;border-radius:10px;font-size:.75em">ERRO</span>`
          : `<span style="background:#f5f5f5;color:#9e9e9e;padding:2px 8px;border-radius:10px;font-size:.75em">sem itens</span>`);

    portaisHtml += `
    <div style="margin-bottom:20px;border-left:3px solid ${cor};padding-left:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <strong style="color:${cor}">${p.nome}</strong> ${badge}
      </div>
      <div style="font-size:.78em;color:#9e9e9e;margin-bottom:6px">
        ${p.url || ''} — consultado ${p.consultadoEm || ''}
      </div>`;

    if (p.erro) {
      portaisHtml += `<p style="color:#c62828;font-size:.88em">⚠ ${p.erro}</p>`;
    } else if (p.observacoes) {
      portaisHtml += `<p style="color:#757575;font-style:italic;font-size:.88em">${p.observacoes}</p>`;
    }

    if (itens.length > 0) {
      portaisHtml += '<ul style="margin:6px 0;padding-left:18px">';
      for (const item of itens) {
        const tagBadges = (item.tags || [])
          .map(t => `<span style="background:#e8eaf6;color:#3949ab;padding:1px 5px;border-radius:3px;font-size:.72em;margin-right:3px">${t}</span>`)
          .join('');
        const conf = item.confianca === 'alta'
          ? '🟢' : item.confianca === 'media' ? '🟡' : '🔴';
        portaisHtml += `
          <li style="margin-bottom:10px">
            <div>${conf} <strong><a href="${item.url || '#'}" style="color:#1565c0">${item.titulo}</a></strong></div>
            <div style="font-size:.8em;color:#888;margin:2px 0">${item.dataPublicacao || ''} · ${item.tipoConteudo || ''} ${tagBadges}</div>
            <div style="color:#555;font-size:.9em">${item.resumoCurto || ''}</div>
          </li>`;
      }
      portaisHtml += '</ul>';
    }
    portaisHtml += '</div>';
  }

  const errosHtml = erros.length > 0
    ? `<div style="background:#ffebee;border:1px solid #ef9a9a;padding:10px;border-radius:4px;margin-bottom:16px">
         <strong style="color:#b71c1c">⚠ Portais com erro (${erros.length}):</strong>
         <ul style="margin:4px 0;padding-left:18px">${erros.map(e => `<li style="font-size:.88em">${e}</li>`).join('')}</ul>
       </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;max-width:820px;margin:0 auto;padding:20px;color:#212121;background:#fafafa}
  .header{background:linear-gradient(135deg,#1a237e,#283593);color:#fff;padding:18px 22px;border-radius:8px 8px 0 0}
  .header h1{margin:0;font-size:1.25em;letter-spacing:.3px}
  .header p{margin:4px 0 0;opacity:.75;font-size:.88em}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
  .stat{background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:8px 14px;text-align:center;min-width:90px}
  .stat .n{font-size:1.5em;font-weight:bold;color:#1a237e}
  .stat .l{font-size:.75em;color:#757575}
  .content{background:#fff;border:1px solid #e0e0e0;border-top:none;padding:20px;border-radius:0 0 8px 8px}
  .rodape{margin-top:20px;color:#9e9e9e;font-size:.75em;border-top:1px solid #eee;padding-top:10px}
</style>
</head>
<body>
<div class="header">
  <h1>⚖️ Curadoria Reforma Tributária do Consumo</h1>
  <p>${data} · Executado em ${exec} (BRT)</p>
</div>
<div class="content">
  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="l">Publicações</div></div>
    <div class="stat"><div class="n">${resultado.totalPortaisVerificados || 0}</div><div class="l">Portais verificados</div></div>
    <div class="stat"><div class="n">${resultado.totalPortaisComItens || 0}</div><div class="l">Com itens</div></div>
    <div class="stat"><div class="n" style="color:${erros.length > 0 ? '#b71c1c' : '#2e7d32'}">${erros.length}</div><div class="l">Erros</div></div>
  </div>
  ${errosHtml}
  ${portaisHtml}
  <div class="rodape">
    TERA Curador Reforma v2 · Auditec-Curador/1.0 (Fiscal Compliance)<br>
    Monitoramento: CT-e · NF-e · CGIBS · MDF-e · NF-ABI · BP-e · NFS-e RTC
  </div>
</div>
</body>
</html>`;

  const assunto = total > 0
    ? `⚖️ [TERA] ${total} publicação(ões) Reforma Tributária — ${data}`
    : erros.length > 0
      ? `⚖️ [TERA] Sem publicações + ${erros.length} erro(s) — ${data}`
      : `⚖️ [TERA] Portais verificados, sem publicações — ${data}`;

  try {
    const info = await transporter.sendMail({
      from: `"TERA Curador Reforma" <${user}>`,
      to,
      subject: assunto,
      html,
    });
    logger.info(`E-mail enviado → ${to} (id: ${info.messageId})`);
  } catch (err) {
    logger.error(`Falha ao enviar e-mail: ${err.message}`);
  }
}

module.exports = { enviarResumo };
