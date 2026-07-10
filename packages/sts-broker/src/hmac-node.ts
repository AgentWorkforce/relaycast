/**
 * Node-side HMAC sign/verify for the STS broker. The Lambda uses these to
 * verify Worker requests and (in tests / local fixtures) sign them.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  buildSigningString,
  isTimestampWithinWindow,
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "./hmac.js";

export type SignedRequestInput = {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  secret: string;
};

export function signRequest(input: SignedRequestInput): string {
  const message = buildSigningString({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp: input.timestamp,
  });
  return createHmac("sha256", input.secret).update(message).digest("base64");
}

export type VerifyRequestInput = {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | undefined> | Headers;
  secret: string;
  maxSkewSeconds?: number;
  nowSeconds?: number;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

function readHeader(
  headers: Record<string, string | undefined> | Headers,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  // HTTP header names are case-insensitive. Lambda Function URL events
  // lowercase header keys, but tests / direct invocations may use any
  // capitalization, so do a case-insensitive scan over the keys.
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

export function verifyRequest(input: VerifyRequestInput): VerifyResult {
  const signatureHeader = readHeader(input.headers, REQUEST_SIGNATURE_HEADER);
  const timestampHeader = readHeader(input.headers, REQUEST_TIMESTAMP_HEADER);
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  if (
    !isTimestampWithinWindow(timestampHeader, {
      maxSkewSeconds: input.maxSkewSeconds,
      nowSeconds: input.nowSeconds,
    })
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = signRequest({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp: timestampHeader,
    secret: input.secret,
  });

  // base64 strings can differ in length only when one side mangled the
  // payload; treat that as a fail before timingSafeEqual (which throws on
  // length mismatch). Beyond that, byte-level constant-time compare.
  const provided = signatureHeader;
  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }

  const providedBytes = Buffer.from(provided, "base64");
  const expectedBytes = Buffer.from(expected, "base64");
  if (
    providedBytes.length === 0 ||
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
