import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getNangoSecretKey } from "@/lib/integrations/nango-service";
import {
  isRickySlackForwardEnvelope,
  parseNangoWebhookEnvelope,
  RelayfilePrimaryWriteError,
  routeNangoWebhook,
  verifyNangoWebhookSignature,
} from "@/lib/integrations/nango-webhook-router";
import {
  handleGitLabHookdeckWebhook,
  looksLikeGitLabWebhook,
} from "@/lib/integrations/gitlab-hookdeck-webhook";
import {
  handleDaytonaHookdeckWebhook,
  looksLikeDaytonaWebhook,
} from "@/lib/integrations/daytona-hookdeck-webhook";
import {
  handleRecallHookdeckWebhook,
  looksLikeRecallWebhook,
} from "@/lib/integrations/recall-hookdeck-webhook";
import {
  handleGcpHookdeckWebhook,
  looksLikeGcpWebhook,
} from "@/lib/integrations/gcp-hookdeck-webhook";
import {
  handleCloudflareHookdeckWebhook,
  looksLikeCloudflareWebhook,
} from "@/lib/integrations/cloudflare-hookdeck-webhook";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { captureError, logger } from "@/lib/logger";

export type NangoWebhookIngress = "nango" | "hookdeck";

type HandleNangoWebhookPostOptions = {
  ingress: NangoWebhookIngress;
  route: string;
};

const HOOKDECK_SIGNATURE_HEADERS = [
  "x-hookdeck-signature",
  "x-hookdeck-signature-2",
] as const;

export function getHookdeckSigningSecret(): string | null {
  return tryResourceValue("HookdeckSigningSecret") ?? optionalEnv("HOOKDECK_SIGNING_SECRET") ?? null;
}

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

export async function handleNangoWebhookPost(
  request: NextRequest,
  options: HandleNangoWebhookPostOptions,
) {
  const startedAt = Date.now();
  const bodyReadStartedAt = Date.now();
  const rawBody = await request.text();
  const bodyReadDurationMs = Date.now() - bodyReadStartedAt;
  const validationStartedAt = Date.now();
  const isGitLabWebhook = looksLikeGitLabWebhook(request.headers);
  if (options.ingress === "hookdeck") {
    const hookdeckSecret = getHookdeckSigningSecret();
    if (
      hookdeckSecret &&
      !isGitLabWebhook &&
      !verifyHookdeckWebhookSignature(rawBody, request.headers, hookdeckSecret)
    ) {
      return NextResponse.json({ error: "Invalid Hookdeck signature" }, { status: 401 });
    }
  }

  const secretKey = getNangoSecretKey();
  const hasNangoSignature =
    request.headers.get("x-nango-signature") ?? request.headers.get("x-nango-hmac-sha256");

  if (options.ingress === "hookdeck" && !hasNangoSignature && isGitLabWebhook) {
    try {
      const gitlabResult = await handleGitLabHookdeckWebhook(rawBody, request.headers);
      if (gitlabResult.handled) {
        return gitlabResult.response;
      }
    } catch (error) {
      await captureError(error, {
        area: "gitlab-webhook",
        ingress: options.ingress,
        route: options.route,
        method: "POST",
      });
      return NextResponse.json(
        { accepted: false, error: "GitLab webhook handling failed" },
        { status: 502 },
      );
    }
  }

  if (options.ingress === "hookdeck" && !hasNangoSignature && looksLikeRecallWebhook(rawBody)) {
    try {
      const recallResult = await handleRecallHookdeckWebhook(rawBody, request.headers);
      if (recallResult.handled) {
        return recallResult.response;
      }
    } catch (error) {
      await captureError(error, {
        area: "recall-webhook",
        ingress: options.ingress,
        route: options.route,
        method: "POST",
      });
      return NextResponse.json(
        { accepted: false, error: "Recall webhook handling failed" },
        { status: 502 },
      );
    }
  }

  if (options.ingress === "hookdeck" && !hasNangoSignature && looksLikeGcpWebhook(rawBody)) {
    try {
      const gcpResult = await handleGcpHookdeckWebhook(rawBody, request.headers);
      if (gcpResult.handled) {
        return gcpResult.response;
      }
    } catch (error) {
      await captureError(error, {
        area: "gcp-webhook",
        ingress: options.ingress,
        route: options.route,
        method: "POST",
      });
      return NextResponse.json(
        { accepted: false, error: "GCP webhook handling failed" },
        { status: 502 },
      );
    }
  }

  if (
    options.ingress === "hookdeck" &&
    !hasNangoSignature &&
    looksLikeCloudflareWebhook(rawBody)
  ) {
    try {
      const cloudflareResult = await handleCloudflareHookdeckWebhook(rawBody, request.headers);
      if (cloudflareResult.handled) {
        return cloudflareResult.response;
      }
    } catch (error) {
      await captureError(error, {
        area: "cloudflare-webhook",
        ingress: options.ingress,
        route: options.route,
        method: "POST",
      });
      return NextResponse.json(
        { accepted: false, error: "Cloudflare webhook handling failed" },
        { status: 502 },
      );
    }
  }

  if (!secretKey) {
    return NextResponse.json({ error: "Nango webhook secret is not configured" }, { status: 503 });
  }

  if (options.ingress === "hookdeck" && !hasNangoSignature && looksLikeDaytonaWebhook(rawBody)) {
    try {
      const daytonaResult = await handleDaytonaHookdeckWebhook(rawBody, request.headers);
      if (daytonaResult.handled) {
        return daytonaResult.response;
      }
    } catch (error) {
      await captureError(error, {
        area: "daytona-webhook",
        ingress: options.ingress,
        route: options.route,
        method: "POST",
      });
      return NextResponse.json(
        { accepted: false, error: "Daytona webhook handling failed" },
        { status: 502 },
      );
    }
  }

  if (!hasNangoSignature || !verifyNangoWebhookSignature(rawBody, request.headers, secretKey)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let envelope;
  try {
    envelope = parseNangoWebhookEnvelope(rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const validationDurationMs = Date.now() - validationStartedAt;

  // Route synchronously before returning. `after()` is unreliable under
  // OpenNext/AWS Lambda (non-streaming Next.js deployments drop queued
  // after() callbacks once the handler returns), which is why forwards to
  // sage had never been firing.
  try {
    const routeStartedAt = Date.now();
    await logger.info("Nango webhook received", {
      area: "nango-webhook",
      ingress: options.ingress,
      route: options.route,
      method: "POST",
      provider: envelope.from,
      type: envelope.type,
      connectionId: envelope.connectionId ?? undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
    });
    await routeNangoWebhook(envelope);
    await logger.info("Nango webhook route timing", {
      area: "nango-webhook",
      ingress: options.ingress,
      route: options.route,
      method: "POST",
      provider: envelope.from,
      type: envelope.type,
      connectionId: envelope.connectionId ?? undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
      bodyReadDurationMs,
      validationDurationMs,
      routeDurationMs: Date.now() - routeStartedAt,
      totalDurationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await captureError(error, {
      area: "nango-webhook",
      ...(envelope.type === "sync" ? { subsystem: "nango-sync-queue" } : {}),
      ingress: options.ingress,
      route: options.route,
      method: "POST",
      provider: envelope.from,
      type: envelope.type,
      connectionId: envelope.connectionId ?? undefined,
      providerConfigKey: envelope.providerConfigKey || undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    if (isRickySlackForwardEnvelope(envelope)) {
      return NextResponse.json(
        {
          accepted: false,
          error: "Ricky Slack webhook handling failed",
          type: envelope.type,
        },
        { status: 502 },
      );
    }
    if (error instanceof RelayfilePrimaryWriteError) {
      return NextResponse.json(
        {
          accepted: false,
          error: "Relayfile primary webhook write failed",
          type: envelope.type,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        accepted: false,
        error: "Nango webhook handling failed",
        type: envelope.type,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      accepted: true,
      type: envelope.type,
      ingress: options.ingress,
    },
    { status: 200 },
  );
}
