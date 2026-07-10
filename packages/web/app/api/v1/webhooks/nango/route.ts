import { NextRequest } from "next/server";
import { handleNangoWebhookPost } from "@/lib/integrations/nango-webhook-route-handler";

const NANGO_WEBHOOK_ROUTE = "/api/v1/webhooks/nango";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return handleNangoWebhookPost(request, {
    ingress: "nango",
    route: NANGO_WEBHOOK_ROUTE,
  });
}
