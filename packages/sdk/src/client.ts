import { SDK_VERSION } from './index.js';

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
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

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error: { code: string; message: string } };

export class HttpClient {
  private apiKey: string;
  private _baseUrl: string;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.agentrelay.dev';
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this._baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'X-SDK-Version': SDK_VERSION,
    };

    const hasBody = body !== undefined && method.toUpperCase() !== 'GET';
    if (hasBody) headers['Content-Type'] = 'application/json';

    const retryBackoffsMs = [200, 400, 800];
    let attempt = 0;

    while (true) {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
      });

      // Retry on 5xx with exponential backoff.
      if (res.status >= 500 && res.status <= 599 && attempt < retryBackoffsMs.length) {
        const backoff = retryBackoffsMs[attempt]!;
        attempt += 1;
        await sleep(backoff);
        continue;
      }

      const parsed = (await res.json()) as ApiOk<T> | ApiErr;
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).ok !== 'boolean') {
        throw new RelayError('invalid_response', 'Invalid API response', res.status);
      }

      if (parsed.ok === false) {
        const code = parsed.error?.code ?? 'unknown_error';
        const message = parsed.error?.message ?? 'Unknown error';
        throw new RelayError(code, message, res.status);
      }

      return parsed.data;
    }
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete(path: string): Promise<void> {
    await this.request<unknown>('DELETE', path);
  }
}

