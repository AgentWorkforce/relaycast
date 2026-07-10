import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  handleTelegramWebhookUpdate,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "@/lib/integrations/telegram/messaging";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ connectionId: string }>;
};

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { connectionId } = await context.params;
  const update = await request.json().catch(() => null);
  if (!update) {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const result = await handleTelegramWebhookUpdate({
    connectionId,
    secretToken: request.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER),
    update,
  });

  if (!result.ok && result.status === "unauthorized") {
    return NextResponse.json(result, { status: 401 });
  }
  if (!result.ok && result.status === "integration_not_found") {
    return NextResponse.json(result, { status: 404 });
  }
  if (!result.ok && result.status === "configuration_error") {
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(result);
}
