type Level = 'debug' | 'info' | 'warn' | 'error';

const silent = process.env.NODE_ENV === 'test';

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (silent && level !== 'error') return;
  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields
  });
  if (level === 'error') console.error(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields)
};
