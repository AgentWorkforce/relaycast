import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../types";
import { enqueueAcceptedWebhook, getRequiredSecret, invalidSignatureResponse } from "../utils";
import { verifyNangoWebhookSignature } from "./nango";

const HOOKDECK_SIGNATURE_HEADERS = [
  "x-hookdeck-signature",
  "x-hookdeck-signature-2",
] as const;

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyHookdeckWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  return HOOKDECK_SIGNATURE_HEADERS.some((header) => {
    const signature = headers.get(header)?.trim();
    return signature ? timingSafeStringEqual(signature, expected) : false;
  });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const hookdeckSecret = getRequiredSecret(env.HOOKDECK_WEBHOOK_SECRET);
  const nangoSecret = getRequiredSecret(env.NANGO_WEBHOOK_SECRET);

  if (!hookdeckSecret || !verifyHookdeckWebhookSignature(rawBody, request.headers, hookdeckSecret)) {
    return invalidSignatureResponse();
  }

  if (!nangoSecret || !verifyNangoWebhookSignature(rawBody, request.headers, nangoSecret)) {
    return invalidSignatureResponse();
  }

  return enqueueAcceptedWebhook(env, "hookdeck", rawBody, request.headers);
}
