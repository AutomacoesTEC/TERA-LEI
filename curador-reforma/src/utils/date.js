'use strict';

const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

/** Data de hoje em BRT: DD/MM/YYYY */
function hoje() {
  return dayjs().tz(TZ).format('DD/MM/YYYY');
}

/** Data de hoje em BRT: YYYY-MM-DD */
function hojeISO() {
  return dayjs().tz(TZ).format('YYYY-MM-DD');
}

/** Data+hora atual em BRT: DD/MM/YYYY HH:mm:ss */
function agora() {
  return dayjs().tz(TZ).format('DD/MM/YYYY HH:mm:ss');
}

/**
 * Verifica se uma string de texto contém a data de hoje (BRT).
 * Reconhece DD/MM/YYYY, DD/MM/YY, DD-MM-YYYY, DD.MM.YYYY
 */
function isHoje(texto) {
  if (!texto) return false;
  const hj = hoje(); // DD/MM/YYYY
  const [hd, hm, hy] = hj.split('/');

  const match = texto.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!match) return false;
  const [, d, m, y] = match;
  const ano = y.length === 2 ? `20${y}` : y;
  return d.padStart(2, '0') === hd &&
         m.padStart(2, '0') === hm &&
         ano === hy;
}

/**
 * Extrai a primeira ocorrência de DD/MM/YYYY (ou DD/MM/YY) de uma string.
 * Retorna string no formato DD/MM/YYYY ou null.
 */
function extrairData(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const ano = y.length === 2 ? `20${y}` : y;
  return `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${ano}`;
}

/** Trunca texto para no máximo N palavras, adicionando '…' se necessário. */
function truncarPalavras(texto, max = 50) {
  if (!texto) return '';
  const palavras = texto.trim().replace(/\s+/g, ' ').split(' ');
  if (palavras.length <= max) return palavras.join(' ');
  return palavras.slice(0, max).join(' ') + '…';
}

module.exports = { hoje, hojeISO, agora, isHoje, extrairData, truncarPalavras, TZ };
