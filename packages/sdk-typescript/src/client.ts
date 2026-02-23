import { z } from 'zod';
import { ApiErrorSchema } from '@relaycast/types';
import { SDK_VERSION } from './version.js';
import { SDK_ORIGIN, type InternalOrigin } from './origin.js';
import { camelizeKeys, decamelizeKey, decamelizeKeys, type Camelize } from './casing.js';

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  schema?: z.ZodType;
}

const INTERNAL_ORIGIN = Symbol('relaycast.internal.origin');

type OriginCapableOptions = {
  apiKey?: string;
  baseUrl?: string;
};

type OriginCapableWithInternalOrigin = OriginCapableOptions & {
  [INTERNAL_ORIGIN]?: InternalOrigin;
};

function readInternalOrigin(options: OriginCapableOptions): InternalOrigin | undefined {
  return (options as OriginCapableWithInternalOrigin)[INTERNAL_ORIGIN];
}

export function withInternalOrigin<T extends OriginCapableOptions>(
  options: T,
  origin: InternalOrigin,
): T {
  const copy = { ...options } as OriginCapableWithInternalOrigin;
  Object.defineProperty(copy, INTERNAL_ORIGIN, {
    value: origin,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy as T;
}

export class RelayError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(options: ClientOptions) {
    const origin = readInternalOrigin(options) ?? SDK_ORIGIN;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.relaycast.dev';
    this._originSurface = origin.surface;
    this._originClient = origin.client;
    this._originVersion = origin.version;
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

  withApiKey(apiKey: string): HttpClient {
    return new HttpClient(withInternalOrigin(
      { apiKey, baseUrl: this._baseUrl },
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

    const retryBackoffsMs = [200, 400, 800];
    let attempt = 0;

    while (true) {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: hasBody ? JSON.stringify(wireBody) : undefined,
      });

      // Retry on 5xx with exponential backoff.
      if (res.status >= 500 && res.status <= 599 && attempt < retryBackoffsMs.length) {
        const backoff = retryBackoffsMs[attempt]!;
        attempt += 1;
        await sleep(backoff);
        continue;
      }

      // 204 No Content — return undefined (used by DELETE endpoints)
      if (res.status === 204) {
        return undefined as Camelize<T>;
      }

      const json: unknown = await res.json();
      const envelope = apiEnvelopeSchema.safeParse(json);

      if (!envelope.success) {
        throw new RelayError('invalid_response', 'Invalid API response', res.status);
      }

      if (!envelope.data.ok) {
        const errParsed = ApiErrorSchema.safeParse(json);
        const code = errParsed.success ? errParsed.data.error.code : 'unknown_error';
        const message = errParsed.success ? errParsed.data.error.message : 'Unknown error';
        throw new RelayError(code, message, res.status);
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
