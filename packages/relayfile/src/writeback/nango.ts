import type { IntegrationCredential } from "./types.js";

export type NangoProxyRequest = {
  method: string;
  endpoint: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  data?: unknown;
};

export type NangoProxyResponse<T = unknown> = {
  ok: boolean;
  status: number;
  headers: Headers;
  data: T | null;
};

export type BoundedTextRead = {
  text: string;
  truncated: boolean;
  bytesRead: number;
};

export const MAX_NANGO_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

export async function nangoProxy<T = unknown>(
  cred: IntegrationCredential,
  req: NangoProxyRequest,
  env: { NANGO_SECRET_KEY?: string; NANGO_BASE_URL?: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<NangoProxyResponse<T>> {
  const secretKey = env.NANGO_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Missing required env var: NANGO_SECRET_KEY");
  }

  const baseUrl = (
    env.NANGO_BASE_URL?.trim() || "https://api.nango.dev"
  ).replace(/\/+$/, "");
  const endpoint = req.endpoint.trim().startsWith("/")
    ? req.endpoint.trim()
    : `/${req.endpoint.trim()}`;
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${secretKey}`);
  headers.set("connection-id", cred.connectionId);
  headers.set("provider-config-key", cred.providerConfigKey);
  if (req.baseUrl) {
    headers.set("base-url-override", req.baseUrl.replace(/\/+$/, ""));
  }
  if (req.data !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const method = req.method.toUpperCase();

  const response = await (options.fetchImpl ?? globalThis.fetch)(
    `${baseUrl}/proxy${endpoint}`,
    {
      method,
      headers,
      ...(req.data === undefined || method === "GET" || method === "HEAD"
        ? {}
        : { body: JSON.stringify(req.data) }),
    },
  );

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: response.headers,
    data: (await parseResponseBody(response)) as T | null,
  };
}

async function parseResponseBody(response: Response): Promise<unknown | null> {
  if (response.status === 204 || response.status === 205) {
    return null;
  }
  const { text, truncated } = await readBoundedText(
    response,
    MAX_NANGO_RESPONSE_BODY_BYTES,
  );
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return text;
  }
  if (truncated) {
    throw new Error(
      `Nango proxy response body exceeded ${MAX_NANGO_RESPONSE_BODY_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function readBoundedText(
  source: Response | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedTextRead> {
  const stream = source && "body" in source ? source.body : source;
  if (!stream) {
    return { text: "", truncated: false, bytesRead: 0 };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          bytesRead += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(bytes),
    truncated,
    bytesRead,
  };
}
