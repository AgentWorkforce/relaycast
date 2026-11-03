/**
 * Structured logging: one line per event. `json` (the default) emits a JSON
 * object per line for log shippers; `text` is for a local terminal. Callers
 * never pass credentials, socket URLs or secrets as fields.
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  format: 'json' | 'text';
  write?: (line: string) => void;
  now?: () => Date;
}

function formatText(time: string, level: LogLevel, event: string, fields: LogFields): string {
  const parts = [time, level.toUpperCase().padEnd(5), event];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === 'string' && /[\s"=]/.test(value) ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${text}`);
  }
  return parts.join(' ');
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const time = now().toISOString();
    if (options.format === 'json') {
      const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      write(JSON.stringify({ time, level, event, ...defined }));
    } else {
      write(formatText(time, level, event, fields));
    }
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** The message of an error, with any `ar_` credential or bearer token masked. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ar_(?:ws|ag|nd|ob|wh)_[0-9A-Za-z_]+/g, 'ar_***').replace(/Bearer\s+\S+/gi, 'Bearer ***');
}
