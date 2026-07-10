import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../types";
import { enqueueAcceptedWebhook, getRequiredSecret, invalidSignatureResponse } from "../utils";

const DEFAULT_TOLERANCE_SECONDS = 300;

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseTimestampSeconds(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.trunc(parsed / 1000);
}

function verifySignature(
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  signature: string,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  const timestampSeconds = parseTimestampSeconds(webhookTimestamp);
  if (timestampSeconds === null) {
    return false;
  }

  const nowSeconds = Math.trunc(Date.now() / 1000);
  if (toleranceSeconds > 0 && Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const signingString = `${webhookId}.${webhookTimestamp}.${body}`;
  const expected = createHmac("sha256", secret)
    .update(signingString)
    .digest("base64");
  const received = signature.split(",")[1] ?? signature;

  return timingSafeStringEqual(expected, received);
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const secret = getRequiredSecret(env.COMPOSIO_WEBHOOK_SECRET);
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");

  if (
    !secret ||
    !webhookId ||
    !webhookTimestamp ||
    !signature ||
    !verifySignature(webhookId, webhookTimestamp, rawBody, signature, secret)
  ) {
    return invalidSignatureResponse();
  }

  return enqueueAcceptedWebhook(env, "composio", rawBody, request.headers);
}
