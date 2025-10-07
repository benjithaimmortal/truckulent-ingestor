import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { dirname } from 'path';

type Level = 'info' | 'warn' | 'error' | 'debug';

let logFilePath: string | undefined;

function ensureFile(path: string) {
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}
  try { writeFileSync(path, '', { flag: 'a' }); } catch {}
}

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const lineObj = { ts, level, msg, ...(meta || {}) };
  const line = JSON.stringify(lineObj);
  // console
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line);
  // file
  if (logFilePath) {
    try { appendFileSync(logFilePath, line + '\n'); } catch {}
  }
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  setFile: (path: string | undefined) => {
    logFilePath = path;
    if (path) ensureFile(path);
  }
};

