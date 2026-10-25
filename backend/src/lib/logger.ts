/** Tiny logger: timestamps + level. Enough for this project, easy to swap later. */
type Level = 'info' | 'warn' | 'error';

function log(level: Level, msg: string, meta?: unknown) {
  if (process.env.NODE_ENV === 'test' && level === 'info') return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  meta === undefined ? out(line) : out(line, meta);
}

export const logger = {
  info: (m: string, meta?: unknown) => log('info', m, meta),
  warn: (m: string, meta?: unknown) => log('warn', m, meta),
  error: (m: string, meta?: unknown) => log('error', m, meta),
};
