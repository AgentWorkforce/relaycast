import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../types";
import { enqueueAcceptedWebhook, getRequiredSecret, invalidSignatureResponse } from "../utils";
import type { TelemetryMeta } from "@cloud/core/observability/telemetry-meta.js";

const NANGO_HMAC_HEADER = "x-nango-hmac-sha256";
const LEGACY_NANGO_SIGNATURE_HEADER = "x-nango-signature";

function isHexDigest(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value);
}

function getHeader(
  headers: Headers | Record<string, unknown>,
  key: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const normalizedKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(headers)) {
    if (entryKey.toLowerCase() !== normalizedKey) {
      continue;
    }

    return typeof value === "string" ? value : null;
  }

  return null;
}

function getHmacSignature(headers: Headers | Record<string, unknown>): string | null {
  return getHeader(headers, NANGO_HMAC_HEADER);
}

function getLegacySignature(headers: Headers | Record<string, unknown>): string | null {
  return getHeader(headers, LEGACY_NANGO_SIGNATURE_HEADER);
}

function verifyHexSignature(expected: string, received: string): boolean {
  if (
    !isHexDigest(expected) ||
    !isHexDigest(received) ||
    expected.length !== received.length
  ) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

function verifyLegacyNangoSignature(
  rawBody: string,
  signature: string,
  secretKey: string,
): boolean {
  const rawExpected = createHash("sha256")
    .update(`${secretKey}${rawBody}`)
    .digest("hex");
  if (verifyHexSignature(rawExpected, signature)) {
    return true;
  }

  try {
    const normalizedExpected = createHash("sha256")
      .update(`${secretKey}${JSON.stringify(JSON.parse(rawBody))}`)
      .digest("hex");
    return verifyHexSignature(normalizedExpected, signature);
  } catch {
    return false;
  }
}

export function verifyNangoWebhookSignature(
  rawBody: string,
  headers: Headers | Record<string, unknown>,
  secretKey: string,
): boolean {
  const hmacSignature = getHmacSignature(headers);
  if (hmacSignature) {
    const expected = createHmac("sha256", secretKey).update(rawBody).digest("hex");
    return verifyHexSignature(expected, hmacSignature);
  }

  const legacySignature = getLegacySignature(headers);
  if (legacySignature) {
    return verifyLegacyNangoSignature(rawBody, legacySignature, secretKey);
  }

  return false;
}

export async function handle(
  request: Request,
  env: Env,
  options: {
    meta?: TelemetryMeta;
  } = {},
): Promise<Response> {
  const rawBody = await request.text();
  const secretKey = getRequiredSecret(env.NANGO_WEBHOOK_SECRET);

  if (!secretKey || !verifyNangoWebhookSignature(rawBody, request.headers, secretKey)) {
    return invalidSignatureResponse();
  }

  return enqueueAcceptedWebhook(env, "nango", rawBody, request.headers, options);
}
