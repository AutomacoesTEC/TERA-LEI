'use strict';

const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const timezone = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = process.env.TIMEZONE || 'America/Sao_Paulo';

/** Retorna a data de hoje em BRT no formato DD/MM/YYYY */
function hoje() {
  return dayjs().tz(TZ).format('DD/MM/YYYY');
}

/** Retorna a data de hoje em BRT no formato YYYY-MM-DD */
function hojeISO() {
  return dayjs().tz(TZ).format('YYYY-MM-DD');
}

/**
 * Verifica se uma string de data contém a data de hoje (BRT).
 * Aceita formatos comuns: DD/MM/YYYY, DD/MM/YY, DD-MM-YYYY, etc.
 */
function isHoje(dateStr) {
  if (!dateStr) return false;
  const hj = hoje(); // "DD/MM/YYYY"
  const [hd, hm, hy] = hj.split('/');

  // Tenta extrair DD/MM/YYYY ou DD-MM-YYYY
  const match = dateStr.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (!match) return false;
  const [, d, m, y] = match;
  const ano = y.length === 2 ? `20${y}` : y;
  return d.padStart(2, '0') === hd &&
         m.padStart(2, '0') === hm &&
         ano === hy;
}

/**
 * Trunca um texto para no máximo N palavras.
 */
function truncarPalavras(texto, max = 50) {
  if (!texto) return '';
  const palavras = texto.trim().split(/\s+/);
  if (palavras.length <= max) return texto.trim();
  return palavras.slice(0, max).join(' ') + '…';
}

module.exports = { hoje, hojeISO, isHoje, truncarPalavras, TZ };
