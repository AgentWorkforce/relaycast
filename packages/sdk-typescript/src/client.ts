import { z } from 'zod';
import { ApiErrorSchema } from '@relaycast/types';
import { SDK_VERSION } from './version.js';
import { SDK_ORIGIN, type InternalOrigin } from './origin.js';
import { camelizeKeys, decamelizeKey, decamelizeKeys, type Camelize } from './casing.js';
import { RelayError, relayErrorFromApi } from './errors.js';

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  retryPolicy?: RetryPolicyInput;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  schema?: z.ZodType;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryOn: number[];
}

export type RetryPolicyInput = Partial<Omit<RetryPolicy, 'retryOn'>> & {
  retryOn?: number[];
};

const INTERNAL_ORIGIN = Symbol('relaycast.internal.origin');

type ClientOptionsWithInternalOrigin = ClientOptions & {
  [INTERNAL_ORIGIN]?: InternalOrigin;
};

function readInternalOrigin(options: ClientOptions): InternalOrigin | undefined {
  return (options as ClientOptionsWithInternalOrigin)[INTERNAL_ORIGIN];
}

export function withInternalOrigin<T extends ClientOptions>(
  options: T,
  origin: InternalOrigin,
): T {
  const copy = { ...options } as ClientOptionsWithInternalOrigin;
  Object.defineProperty(copy, INTERNAL_ORIGIN, {
    value: origin,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy as T;
}

export { RelayError } from './errors.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  backoffMultiplier: 2,
  jitter: true,
  retryOn: [429, 500, 502, 503, 504],
};

function normalizeRetryPolicy(input?: RetryPolicyInput): RetryPolicy {
  return {
    maxRetries: Number.isFinite(input?.maxRetries) ? Math.max(0, Math.floor(input!.maxRetries!)) : DEFAULT_RETRY_POLICY.maxRetries,
    backoffMs: Number.isFinite(input?.backoffMs) ? Math.max(0, Math.floor(input!.backoffMs!)) : DEFAULT_RETRY_POLICY.backoffMs,
    backoffMultiplier: Number.isFinite(input?.backoffMultiplier)
      ? Math.max(1, input!.backoffMultiplier!)
      : DEFAULT_RETRY_POLICY.backoffMultiplier,
    jitter: typeof input?.jitter === 'boolean' ? input.jitter : DEFAULT_RETRY_POLICY.jitter,
    retryOn: Array.isArray(input?.retryOn)
      ? input.retryOn.filter((status): status is number => Number.isInteger(status) && status >= 100)
      : [...DEFAULT_RETRY_POLICY.retryOn],
  };
}

function computeBackoffMs(policy: RetryPolicy, retryAttempt: number): number {
  const exponential = policy.backoffMs * (policy.backoffMultiplier ** retryAttempt);
  if (!policy.jitter) return Math.max(0, Math.round(exponential));
  const jitterFactor = 0.5 + Math.random();
  return Math.max(0, Math.round(exponential * jitterFactor));
}

function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, Math.round(asSeconds * 1000));
  }

  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

const apiEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  cursor: z.object({
    next: z.string().nullable(),
    has_more: z.boolean(),
  }).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

export class HttpClient {
  private _apiKey: string;
  private _baseUrl: string;
  private _originSurface: string;
  private _originClient: string;
  private _originVersion: string;
  private _retryPolicy: RetryPolicy;

  constructor(options: ClientOptions) {
    const origin = readInternalOrigin(options) ?? SDK_ORIGIN;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.relaycast.dev';
    this._originSurface = origin.surface;
    this._originClient = origin.client;
    this._originVersion = origin.version;
    this._retryPolicy = normalizeRetryPolicy(options.retryPolicy);
  }

  get apiKey(): string {
    return this._apiKey;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get originSurface(): string {
    return this._originSurface;
  }

  get originClient(): string {
    return this._originClient;
  }

  get originVersion(): string {
    return this._originVersion;
  }

  get retryPolicy(): RetryPolicy {
    return this._retryPolicy;
  }

  withApiKey(apiKey: string): HttpClient {
    return new HttpClient(withInternalOrigin(
      { apiKey, baseUrl: this._baseUrl, retryPolicy: this._retryPolicy },
      {
        surface: this._originSurface,
        client: this._originClient,
        version: this._originVersion,
      },
    ));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<Camelize<T>> {
    const url = new URL(path, this._baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(decamelizeKey(k), v);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      'X-SDK-Version': SDK_VERSION,
      'X-Relaycast-Origin-Surface': this._originSurface,
      'X-Relaycast-Origin-Client': this._originClient,
      'X-Relaycast-Origin-Version': this._originVersion,
      ...(options?.headers || {}),
    };

    const hasBody = body !== undefined && method.toUpperCase() !== 'GET';
    if (hasBody) headers['Content-Type'] = 'application/json';
    const wireBody = hasBody ? decamelizeKeys(body) : undefined;

    let attempt = 0;

    while (true) {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body: hasBody ? JSON.stringify(wireBody) : undefined,
        });
      } catch (err) {
        if (attempt < this._retryPolicy.maxRetries) {
          const waitMs = computeBackoffMs(this._retryPolicy, attempt);
          attempt += 1;
          await sleep(waitMs);
          continue;
        }
        throw new RelayError(
          'transport_error',
          `Network request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          { retryable: true, cause: err },
        );
      }

      if (this._retryPolicy.retryOn.includes(res.status) && attempt < this._retryPolicy.maxRetries) {
        const waitMs = res.status === 429
          ? parseRetryAfterMs(res) ?? computeBackoffMs(this._retryPolicy, attempt)
          : computeBackoffMs(this._retryPolicy, attempt);
        attempt += 1;
        await sleep(waitMs);
        continue;
      }

      // 204 No Content — return undefined (used by DELETE endpoints)
      if (res.status === 204) {
        return undefined as Camelize<T>;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        throw new RelayError(
          'transport_error',
          `Failed to parse response as JSON: ${err instanceof Error ? err.message : 'unknown error'}`,
          { statusCode: res.status, retryable: false, cause: err },
        );
      }
      const envelope = apiEnvelopeSchema.safeParse(json);

      if (!envelope.success) {
        throw new RelayError('transport_error', 'Invalid API response', {
          statusCode: res.status,
          retryable: false,
        });
      }

      if (!envelope.data.ok) {
        const errParsed = ApiErrorSchema.safeParse(json);
        const code = errParsed.success ? errParsed.data.error.code : 'unknown_error';
        const message = errParsed.success ? errParsed.data.error.message : 'Unknown error';
        throw relayErrorFromApi(code, message, res.status);
      }

      const data = envelope.data.data;

      const parsedData = options?.schema ? options.schema.parse(data) : data;
      return camelizeKeys(parsedData) as Camelize<T>;
    }
  }

  get<T>(path: string, query?: Record<string, string>, options?: RequestOptions): Promise<Camelize<T>> {
    return this.request<T>('GET', path, undefined, query, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Camelize<T>> {
    return this.request<T>('POST', path, body, undefined, options);
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Camelize<T>> {
    return this.request<T>('PATCH', path, body, undefined, options);
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Camelize<T>> {
    return this.request<T>('PUT', path, body, undefined, options);
  }

  async delete(path: string, options?: RequestOptions): Promise<void> {
    await this.request<unknown>('DELETE', path, undefined, undefined, options);
  }
}
