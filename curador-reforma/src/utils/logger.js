'use strict';

const fs   = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFile = path.join(logsDir, 'curador.log');

function log(level, msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch (_) {}
}

module.exports = {
  info:  (msg) => log('INFO',  msg),
  warn:  (msg) => log('WARN',  msg),
  error: (msg) => log('ERROR', msg),
};
