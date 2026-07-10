import type { NextRequest } from "next/server";

import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { telegramProxyRequest } from "@/lib/integrations/nango-telegram";
import { getProviderConfigKey } from "@/lib/integrations/nango-service";
import {
  getAllowedTelegramProxyMethods,
  isAllowedTelegramProxyRoute,
  telegramProxyRequestSchema,
} from "@/lib/integrations/telegram-proxy-schema";
import { getWorkspaceIntegration } from "@/lib/integrations/workspace-integrations";

export const runtime = "nodejs";

const TELEGRAM_PROVIDER = "telegram";

type TelegramProxyCode =
  | "unauthorized"
  | "bad_request"
  | "not_connected"
  | "telegram_error"
  | "upstream_error";

type TelegramProxySuccessBody = {
  ok: true;
  data: unknown;
  workspaceId: string;
};

type TelegramProxyErrorBody = {
  ok: false;
  error: string;
  code: TelegramProxyCode;
  allowedMethods?: string[];
};

function jsonResponse(
  body: TelegramProxySuccessBody | TelegramProxyErrorBody,
  init?: ResponseInit,
): Response {
  return Response.json(body, init);
}

function errorResponse(
  status: number,
  code: TelegramProxyCode,
  error: string,
  extra: Pick<TelegramProxyErrorBody, "allowedMethods"> = {},
): Response {
  return jsonResponse(
    {
      ok: false,
      error,
      code,
      ...(extra.allowedMethods ? { allowedMethods: extra.allowedMethods } : {}),
    },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractTelegramError(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.ok !== false) {
    return null;
  }

  const description = payload.description;
  return typeof description === "string" && description.trim().length > 0
    ? description.trim()
    : "Telegram request failed";
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return errorResponse(401, "unauthorized", "Authentication required");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON body");
  }

  const parsed = telegramProxyRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResponse(
      400,
      "bad_request",
      parsed.error.issues[0]?.message ?? "Invalid request body",
    );
  }

  const body = parsed.data;
  if (!isAllowedTelegramProxyRoute(body.endpoint, body.method)) {
    const allowedMethods = getAllowedTelegramProxyMethods(body.endpoint);
    return errorResponse(
      400,
      "bad_request",
      allowedMethods.length > 0
        ? `Telegram endpoint ${body.endpoint} does not allow ${body.method}`
        : `Telegram endpoint ${body.endpoint} is not allowlisted`,
      allowedMethods.length > 0 ? { allowedMethods } : {},
    );
  }

  const integration = await getWorkspaceIntegration(
    auth.workspaceId,
    TELEGRAM_PROVIDER,
  );
  if (!integration) {
    return errorResponse(
      404,
      "not_connected",
      "Telegram is not connected for this workspace. Connect Telegram from the workspace integrations page.",
    );
  }

  const providerConfigKey =
    integration.providerConfigKey?.trim() ||
    getProviderConfigKey(TELEGRAM_PROVIDER);

  try {
    const upstream = await telegramProxyRequest({
      method: body.method,
      endpoint: body.endpoint,
      providerConfigKey,
      connectionId: integration.connectionId,
      ...(body.params ? { params: body.params } : {}),
      ...(body.data === undefined ? {} : { data: body.data }),
    });

    const telegramError = extractTelegramError(upstream);
    if (telegramError) {
      return errorResponse(200, "telegram_error", telegramError);
    }

    return jsonResponse({
      ok: true,
      data: upstream,
      workspaceId: auth.workspaceId,
    });
  } catch {
    return errorResponse(
      502,
      "upstream_error",
      "Telegram upstream request failed",
    );
  }
}
