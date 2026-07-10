const HEADER_DENY_LIST = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-relayauth-token",
  "x-api-key",
]);

const SENSITIVE_HEADER_NAME = /(token|secret|password|signature)/i;

const FULL_BODY_REDACTION_PATHS = [
  /^\/api\/v1\/workspaces\/[a-zA-Z0-9_-]+\/secrets(?:\/.*)?$/,
  /^\/api\/auth(?:\/.*)?$/,
  /^\/api\/v1\/auth(?:\/.*)?$/,
  /^\/api\/v1\/cli\/auth(?:\/.*)?$/,
  /^\/api\/v1\/cli\/login(?:\/.*)?$/,
  /^\/api\/v1\/integrations\/nango\/connect-link(?:\/.*)?$/,
  /^\/api\/v1\/workspaces\/[a-zA-Z0-9_-]+\/integrations\/connect-session(?:\/.*)?$/,
  // Recorder transcript ingest carries full meeting transcript_text/summary_text;
  // never persist its body to the traffic corpus. Match with or without the
  // /cloud app prefix.
  /^\/(?:cloud\/)?api\/v1\/webhooks\/transcripts(?:\/.*)?$/,
];

const JSON_SECRET_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "password",
  "clientsecret",
  "privatekey",
]);

type HeaderInput = Headers | Iterable<[string, string]> | Record<string, string>;

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function redactValue(value: string): string {
  return `[REDACTED:${utf8ByteLength(value)}]`;
}

function shouldRedactHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return HEADER_DENY_LIST.has(normalized) || SENSITIVE_HEADER_NAME.test(normalized);
}

function headerEntries(headers: HeaderInput): Iterable<[string, string]> {
  if (headers instanceof Headers) {
    const entries: Array<[string, string]> = [];
    headers.forEach((value, name) => {
      entries.push([name, value]);
    });
    return entries;
  }

  if (Symbol.iterator in Object(headers)) {
    return headers as Iterable<[string, string]>;
  }

  return Object.entries(headers);
}

function shouldFullyRedactBody(path: string): boolean {
  return FULL_BODY_REDACTION_PATHS.some((pattern) => pattern.test(path));
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("application/json");
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = JSON_SECRET_KEYS.has(key.toLowerCase())
      ? redactValue(typeof nested === "string" ? nested : JSON.stringify(nested) ?? "")
      : redactJsonValue(nested);
  }

  return output;
}

export function redactHeaders(headers: HeaderInput): Record<string, string> {
  const output: Record<string, string> = {};

  for (const [name, value] of headerEntries(headers)) {
    output[name] = shouldRedactHeader(name) ? redactValue(value) : value;
  }

  return output;
}

export function redactBody(
  path: string,
  body: string | null | undefined,
  contentType?: string | null,
): string | null | undefined {
  if (body == null) {
    return body;
  }

  if (shouldFullyRedactBody(path)) {
    return redactValue(body);
  }

  if (!isJsonContentType(contentType)) {
    return body;
  }

  try {
    return JSON.stringify(redactJsonValue(JSON.parse(body)));
  } catch {
    return body;
  }
}

export function shouldRecord(path: string): boolean {
  if (path === "/favicon.ico" || path === "/api/health") {
    return false;
  }

  return path !== "/observer" && !path.startsWith("/observer/");
}
