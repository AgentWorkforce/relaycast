import type { Context } from 'hono';
import type { AppEnv, EngineRuntime } from '../env.js';
import type { EngineLogExport, EngineLogRecord } from '../ports/logging.js';

type LogLevel = EngineLogRecord['level'];
type LogFields = EngineLogRecord['fields'];

const DEFAULT_APP_VERSION = '0.1.0';
const DEFAULT_SDK_VERSION = 'unknown';
export interface LoggerEnv {
  environment: string;
  appVersion?: string;
  appSemver?: string;
  sdkSemver?: string;
  logExport?: EngineLogExport;
}

export interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
  flush: () => Promise<void>;
  child: (source: string, fields?: LogFields) => Logger;
}

interface CreateLoggerOptions {
  source: string;
  request?: Request;
  sdkVersion?: string;
  fields?: LogFields;
  state?: LoggerState;
}

interface LoggerState {
  pending: Set<Promise<void>>;
}

/** Build a {@link LoggerEnv} from the engine runtime's config. */
export function loggerEnvFromRuntime(runtime: EngineRuntime | undefined): LoggerEnv {
  const config = runtime?.config ?? {};
  return {
    environment: config.environment ?? 'development',
    appVersion: config.appVersion,
    appSemver: config.appSemver,
    sdkSemver: config.sdkSemver,
    logExport: config.logExport,
  };
}

function getAppVersion(env: LoggerEnv): string {
  return env.appSemver ?? env.appVersion ?? DEFAULT_APP_VERSION;
}

function getSdkVersion(env: LoggerEnv, request?: Request, explicit?: string): string {
  if (explicit) return explicit;
  const fromHeader = request?.headers.get('x-sdk-version');
  if (fromHeader) return fromHeader;
  return env.sdkSemver ?? DEFAULT_SDK_VERSION;
}

function writeConsole(level: LogLevel, source: string, message: string, metadata: LogFields): void {
  const line = `[${source}] ${message}`;
  if (level === 'debug') {
    console.debug(line, metadata);
    return;
  }
  if (level === 'info') {
    console.info(line, metadata);
    return;
  }
  if (level === 'warn') {
    console.warn(line, metadata);
    return;
  }
  console.error(line, metadata);
}

export function createLogger(env: LoggerEnv, options: CreateLoggerOptions): Logger {
  const appVersion = getAppVersion(env);
  const sdkVersion = getSdkVersion(env, options.request, options.sdkVersion);
  const baseFields = options.fields ?? {};
  const state = options.state ?? { pending: new Set<Promise<void>>() };

  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const metadata: LogFields = {
      app_version: appVersion,
      sdk_version: sdkVersion,
      environment: env.environment,
      source: options.source,
      ...baseFields,
      ...fields,
    };

    writeConsole(level, options.source, message, metadata);
    if (!env.logExport) return;
    try {
      const promise = Promise.resolve(env.logExport({ level, message, fields: metadata, occurredAt: new Date().toISOString() })).catch(() => {});
      state.pending.add(promise);
      void promise.then(() => state.pending.delete(promise));
    } catch {
      // A host transport must never alter request handling.
    }
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    flush: async () => {
      if (state.pending.size === 0) return;
      await Promise.allSettled(Array.from(state.pending));
    },
    child: (source, fields = {}) => createLogger(env, {
      source,
      request: options.request,
      sdkVersion: options.sdkVersion,
      fields: { ...baseFields, ...fields },
      state,
    }),
  };
}

export function createRequestLogger(
  c: Context<AppEnv>,
  source: string,
  fields?: LogFields,
): Logger {
  const request = (() => {
    const maybeReq = (c as unknown as { req?: { raw?: unknown } }).req?.raw;
    return maybeReq instanceof Request ? maybeReq : undefined;
  })();

  const contextReq = (c as unknown as { req?: { path?: string; method?: string } }).req;
  const maybeRequestId = (c as unknown as { get?: (key: string) => unknown }).get?.('requestId');
  const requestId = typeof maybeRequestId === 'string' ? maybeRequestId : undefined;
  const runtime = (c as unknown as { get?: (key: string) => unknown }).get?.('engine') as
    | EngineRuntime
    | undefined;

  return createLogger(loggerEnvFromRuntime(runtime), {
    source,
    request,
    fields: {
      ...(requestId ? { request_id: requestId } : {}),
      ...(contextReq?.path ? { route: contextReq.path } : {}),
      ...(contextReq?.method ? { method: contextReq.method } : {}),
      ...(fields ?? {}),
    },
  });
}

export function getRequestLogger(
  c: Context<AppEnv>,
  source: string,
  fields?: LogFields,
): Logger {
  const maybeLogger = (c as unknown as { get?: (key: string) => unknown }).get?.('logger');
  if (
    maybeLogger &&
    typeof maybeLogger === 'object' &&
    typeof (maybeLogger as Logger).child === 'function'
  ) {
    return (maybeLogger as Logger).child(source, fields);
  }
  return createRequestLogger(c, source, fields);
}

/**
 * Flatten an error for structured logs. Drizzle wraps driver failures as
 * "Failed query: <sql>" and keeps the database's reason (e.g. a D1
 * constraint or bind-limit error) on `cause`, so every cause message is
 * appended to `error_message`.
 */
export function toErrorDetails(error: unknown): { error_name: string; error_message: string; error_stack?: string } {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: [error.message, ...causeMessages(error)].join(' | cause: '),
      ...(error.stack ? { error_stack: error.stack } : {}),
    };
  }
  return {
    error_name: 'NonError',
    error_message: String(error),
  };
}

function causeMessages(error: Error): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error.cause;
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    if (typeof cause === 'object') {
      // Drivers also attach plain `{ message, cause }` objects, not only Errors.
      const record = cause as { message?: unknown; cause?: unknown };
      messages.push(typeof record.message === 'string' ? record.message : String(cause));
      cause = record.cause;
    } else {
      messages.push(String(cause));
      cause = undefined;
    }
  }
  return messages;
}
