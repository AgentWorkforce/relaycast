import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import { reapExpiredCloudAgentBoxKeepalives } from "@/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager";

type ReaperRequest = {
  limit?: unknown;
};

function hasRelaycronSecret(request: NextRequest): boolean {
  const expected =
    tryResourceValue("RelaycronApiKey") ??
    process.env.RELAYCRON_API_KEY?.trim();
  const provided = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  return Boolean(expected && provided && constantTimeEqual(provided, expected));
}

function readLimit(body: ReaperRequest | null): number | undefined {
  return typeof body?.limit === "number" && Number.isFinite(body.limit)
    ? Math.max(1, Math.floor(body.limit))
    : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasRelaycronSecret(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as ReaperRequest | null;
  const result = await reapExpiredCloudAgentBoxKeepalives(undefined, { limit: readLimit(body) });

  return NextResponse.json({ ok: true, data: result });
}
