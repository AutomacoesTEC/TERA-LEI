'use strict';

const nodemailer = require('nodemailer');
const logger = require('./logger');

/**
 * Envia o e-mail de resumo da curadoria diária.
 * É SEMPRE enviado, mesmo que totalItens === 0.
 */
async function enviarResumo(curadoria) {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const to   = process.env.EMAIL_TO || 'tectributos.federal11@gmail.com';

  if (!user || !pass) {
    logger.warn('EMAIL_USER ou EMAIL_PASS não definidos — e-mail não enviado');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  const totalItens = curadoria.totalItens || 0;
  const data = curadoria.dataVerificacao || '';

  // ── Monta corpo HTML ──────────────────────────────────────────────────────
  let portaisHtml = '';
  for (const portal of curadoria.portais || []) {
    const itens = portal.itens || [];
    const cor = itens.length > 0 ? '#1a237e' : '#9e9e9e';
    portaisHtml += `
      <div style="margin-bottom:24px;border-left:4px solid ${cor};padding-left:12px;">
        <h3 style="margin:0 0 4px;color:${cor}">
          ${portal.nome}
          <span style="font-weight:normal;font-size:0.85em;color:#888">(${itens.length} item(ns))</span>
        </h3>
        <p style="margin:0 0 4px;font-size:0.8em;color:#aaa">${portal.url || ''}</p>`;

    if (itens.length === 0) {
      portaisHtml += `<p style="color:#bbb;font-style:italic">Sem publicações hoje.</p>`;
    } else {
      portaisHtml += '<ul style="padding-left:18px;margin:8px 0">';
      for (const item of itens) {
        const tags = (item.tags || []).map(t => `<span style="background:#e8eaf6;color:#3949ab;padding:1px 5px;border-radius:3px;font-size:0.75em;margin-right:3px">${t}</span>`).join('');
        portaisHtml += `
          <li style="margin-bottom:12px;list-style:disc">
            <strong><a href="${item.url || '#'}" style="color:#1565c0">${item.titulo || '(sem título)'}</a></strong><br>
            <small style="color:#888">${item.dataPublicacao || ''}</small>&nbsp;${tags}<br>
            <span style="color:#555;font-size:0.92em">${item.resumoCurto || ''}</span>
          </li>`;
      }
      portaisHtml += '</ul>';
    }
    portaisHtml += '</div>';
  }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;max-width:820px;margin:0 auto;padding:20px;color:#212121}
  .header{background:#1a237e;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0}
  .header h1{margin:0;font-size:1.3em}
  .header p{margin:4px 0 0;opacity:.8;font-size:.9em}
  .badge{display:inline-block;background:#fff;color:#1a237e;font-weight:bold;
         padding:6px 14px;border-radius:20px;font-size:1.1em;margin:10px 0}
  .content{border:1px solid #e0e0e0;border-top:none;padding:20px;border-radius:0 0 6px 6px}
  .rodape{margin-top:24px;color:#9e9e9e;font-size:.78em;border-top:1px solid #eee;padding-top:10px}
</style>
</head>
<body>
  <div class="header">
    <h1>⚖️ Curadoria Reforma Tributária</h1>
    <p>${data} • TERA Curador Reforma v2</p>
  </div>
  <div class="content">
    <div class="badge">${totalItens} publicação(ões) encontrada(s) hoje</div>
    ${portaisHtml}
    <div class="rodape">
      Gerado automaticamente pelo TERA Curador Reforma v2 &bull;
      Auditec-Curador/1.0 (Fiscal Compliance) &bull;
      Monitoramento: IBS · CBS · IS · NF-e · CT-e · MDF-e · NFS-e · BP-e · NF-ABI
    </div>
  </div>
</body>
</html>`;

  const assunto = totalItens > 0
    ? `⚖️ [TERA] ${totalItens} publicação(ões) Reforma Tributária — ${data}`
    : `⚖️ [TERA] Sem novas publicações da Reforma — ${data}`;

  try {
    const info = await transporter.sendMail({
      from: `"TERA Curador Reforma" <${user}>`,
      to,
      subject: assunto,
      html,
    });
    logger.info(`E-mail enviado para ${to} (messageId: ${info.messageId})`);
  } catch (err) {
    logger.error(`Erro ao enviar e-mail: ${err.message}`);
  }
}

module.exports = { enviarResumo };
