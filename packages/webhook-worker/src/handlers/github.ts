import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../types";
import { enqueueAcceptedWebhook, getRequiredSecret, invalidSignatureResponse } from "../utils";

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    "utf8",
  );
  const provided = Buffer.from(signature, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const webhookSecret = getRequiredSecret(env.GITHUB_WEBHOOK_SECRET);
  const signature = request.headers.get("x-hub-signature-256");

  if (!webhookSecret || !verifySignature(rawBody, signature, webhookSecret)) {
    return invalidSignatureResponse();
  }

  return enqueueAcceptedWebhook(env, "github", rawBody, request.headers);
}
