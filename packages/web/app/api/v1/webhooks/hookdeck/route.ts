import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { optionalEnv, tryResourceValue } from "@/lib/env";
import { handleNangoWebhookPost } from "@/lib/integrations/nango-webhook-route-handler";

const HOOKDECK_WEBHOOK_ROUTE = "/api/v1/webhooks/hookdeck";
const DROPBOX_SIGNATURE_HEADER = "x-dropbox-signature";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const challenge = new URL(request.url).searchParams.get("challenge");
  if (challenge === null) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "POST",
        "Cache-Control": "no-store",
        "Content-Type": "text/plain",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return new Response(challenge, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: NextRequest) {
  if (request.headers.has(DROPBOX_SIGNATURE_HEADER)) {
    return handleDropboxWebhookPost(request);
  }

  return handleNangoWebhookPost(request, {
    ingress: "hookdeck",
    route: HOOKDECK_WEBHOOK_ROUTE,
  });
}

function getDropboxAppSecret(): string | null {
  return tryResourceValue("DropboxAppSecret") ?? optionalEnv("DROPBOX_APP_SECRET") ?? null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyDropboxWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const signature = headers.get(DROPBOX_SIGNATURE_HEADER)?.trim() ?? "";
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return timingSafeStringEqual(signature, expected);
}

async function handleDropboxWebhookPost(request: NextRequest) {
  const rawBody = await request.text();
  const appSecret = getDropboxAppSecret();

  if (!appSecret) {
    return NextResponse.json(
      {
        accepted: false,
        error: "Dropbox app secret is not configured",
      },
      { status: 503 },
    );
  }

  if (!verifyDropboxWebhookSignature(rawBody, request.headers, appSecret)) {
    return NextResponse.json(
      { accepted: false, error: "Invalid Dropbox signature" },
      { status: 401 },
    );
  }

  // Direct Dropbox notifications do not include Cloud workspace or Nango
  // connection identifiers, so this route authenticates them but leaves
  // provider-specific ingestion for a Dropbox adapter follow-up.
  return NextResponse.json({
    accepted: true,
    type: "dropbox",
    ingress: "hookdeck",
    routed: false,
  });
}
