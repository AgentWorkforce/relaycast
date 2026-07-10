import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  buildIntegrationListEntry,
  type IntegrationListEntry,
} from "@/lib/integrations/integration-list";
import { listUserIntegrations } from "@/lib/integrations/user-integrations";

type ErrorResponse = { error: string };

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);

  if (!auth) {
    return NextResponse.json<ErrorResponse>({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json<ErrorResponse>({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const integrations = await listUserIntegrations(auth.userId);
    const entries = await Promise.all(integrations.map(buildIntegrationListEntry));
    return NextResponse.json<IntegrationListEntry[]>(entries);
  } catch (error) {
    console.error("User integration listing failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to list integrations" },
      { status: 500 },
    );
  }
}
