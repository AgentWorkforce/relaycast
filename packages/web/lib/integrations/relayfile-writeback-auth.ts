import { createHmac, timingSafeEqual } from "node:crypto";
import { Resource } from "sst";
import { optionalEnv } from "../env";

const DEFAULT_INTERNAL_MAX_SKEW_MS = 5 * 60 * 1000;

export function resolveRelayfileInternalHmacSecret(): string {
  let resourceValue: string | undefined;
  try {
    resourceValue = Resource.RelayfileInternalHmacSecret.value?.trim();
  } catch {
    resourceValue = undefined;
  }
  const value = resourceValue ?? optionalEnv("RELAYFILE_INTERNAL_HMAC_SECRET")?.trim();
  if (!value) {
    throw new Error("Missing SST resource: RelayfileInternalHmacSecret");
  }
  return value;
}

export function signRelayfileInternalRequest(
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest("hex");
}

export function verifyRelayfileInternalRequest(
  headers: Headers,
  rawBody: string,
  options?: {
    nowMs?: number;
    secret?: string;
  },
): boolean {
  const timestamp = headers.get("x-relay-timestamp")?.trim() ?? "";
  const signature = headers.get("x-relay-signature")?.trim().toLowerCase() ?? "";
  if (!timestamp || !signature) {
    return false;
  }

  const parsedTimestampMs = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestampMs)) {
    return false;
  }

  const nowMs = options?.nowMs ?? Date.now();
  if (Math.abs(nowMs - parsedTimestampMs) > DEFAULT_INTERNAL_MAX_SKEW_MS) {
    return false;
  }

  const secret = options?.secret ?? resolveRelayfileInternalHmacSecret();
  const expected = Buffer.from(
    signRelayfileInternalRequest(timestamp, rawBody, secret),
    "utf8",
  );
  const provided = Buffer.from(signature, "utf8");

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
