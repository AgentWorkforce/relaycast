import type { Context } from 'hono';
import type { AppEnv, EngineRuntime } from '../env.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

const DEFAULT_POSTHOG_HOST = 'https://i.agentrelay.com';
const DEFAULT_APP_VERSION = '0.1.0';
const DEFAULT_SDK_VERSION = 'unknown';
const SERVICE_NAME = 'relaycast-server';
const LOGGER_SCOPE = 'relaycast.server.logger';

const SEVERITY_BY_LEVEL: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

/**
 * Minimal logging config the engine needs — resolved from {@link EngineConfig}
 * by an adapter. Platform-agnostic: production logs are exported to a PostHog
 * OTLP endpoint via plain `fetch` only when `posthogApiKey` is set (cloud);
 * otherwise the logger writes to the console (self-host / dev).
 */
export interface LoggerEnv {
  environment: string;
  appVersion?: string;
  appSemver?: string;
  sdkSemver?: string;
  posthogApiKey?: string;
  posthogHost?: string;
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
    posthogApiKey: config.logExport?.posthogApiKey,
    posthogHost: config.logExport?.posthogHost,
  };
}

function getPostHogHost(env: LoggerEnv): string {
  const configured = env.posthogHost ?? DEFAULT_POSTHOG_HOST;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
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

function toAttributeValue(value: unknown): { stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number } {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (Number.isFinite(value) && Number.isInteger(value)) return { intValue: String(value) };
    if (Number.isFinite(value)) return { doubleValue: value };
    return { stringValue: String(value) };
  }
  if (value === null) return { stringValue: 'null' };
  if (value === undefined) return { stringValue: 'undefined' };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function metadataToAttributes(metadata: LogFields): Array<{ key: string; value: ReturnType<typeof toAttributeValue> }> {
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }));
}

async function sendToPostHog(
  env: LoggerEnv,
  level: LogLevel,
  message: string,
  metadata: LogFields,
  appVersion: string,
): Promise<void> {
  const apiKey = env.posthogApiKey;
  if (!apiKey) return;

  const timestampNanos = `${Date.now()}000000`;
  const payload = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: SERVICE_NAME } },
          { key: 'service.version', value: { stringValue: appVersion } },
          { key: 'deployment.environment', value: { stringValue: env.environment } },
        ],
      },
      scopeLogs: [{
        scope: { name: LOGGER_SCOPE, version: appVersion },
        logRecords: [{
          timeUnixNano: timestampNanos,
          observedTimeUnixNano: timestampNanos,
          severityNumber: SEVERITY_BY_LEVEL[level],
          severityText: level.toUpperCase(),
          body: { stringValue: message },
          attributes: metadataToAttributes(metadata),
        }],
      }],
    }],
  };

  try {
    const response = await globalThis.fetch(`${getPostHogHost(env)}/i/v1/logs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Best effort: ignore non-2xx response from logging backend.
    }
  } catch {
    // Best effort: do not fail request handling if log export fails.
  }
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

    // Always write to the console so logs are never silently lost — even in
    // production, where the OTLP export can fail (network/misconfig) and
    // swallows its own errors. When a PostHog key is configured we additionally
    // export to the OTLP endpoint.
    writeConsole(level, options.source, message, metadata);
    if (!env.posthogApiKey) return;

    const promise = sendToPostHog(env, level, message, metadata, appVersion);
    state.pending.add(promise);
    void promise.finally(() => state.pending.delete(promise));
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

export function toErrorDetails(error: unknown): { error_name: string; error_message: string; error_stack?: string } {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(error.stack ? { error_stack: error.stack } : {}),
    };
  }
  return {
    error_name: 'NonError',
    error_message: String(error),
  };
}
