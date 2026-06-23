import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface SafeParseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

type ParsedJsonBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

export function jsonOk<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true as const, data }, status);
}

export function jsonCreated<T>(c: Context, data: T) {
  return jsonOk(c, data, 201);
}

export function jsonNoContent(c: Context) {
  return c.body(null, 204);
}

export function jsonError(c: Context, code: string, message: string, status: ContentfulStatusCode) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

export function jsonInvalidRequest(c: Context, message: string) {
  return jsonError(c, 'invalid_request', message, 400);
}

export function jsonNotFound(c: Context, code: string, message: string) {
  return jsonError(c, code, message, 404);
}

export function jsonMalformedBody(c: Context) {
  return jsonError(c, 'invalid_json', 'Malformed JSON in request body', 400);
}

export async function parseJsonBody<T>(
  c: Context,
  schema: SafeParseSchema<T>,
  invalidMessage: string,
): Promise<ParsedJsonBody<T>> {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: jsonMalformedBody(c) };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: jsonInvalidRequest(c, invalidMessage) };
  }

  return { ok: true, data: parsed.data };
}
