import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import { backfillRelayfileWritebackCf } from "@/lib/integrations/relayfile-writeback-dispatch-backfill";

export const runtime = "nodejs";

const APPLY_CONFIRMATION = "flip-writeback-bridge-to-cf";

type BackfillRequest = {
  dryRun?: unknown;
  provider?: unknown;
  workspaceId?: unknown;
  limit?: unknown;
  timeoutMs?: unknown;
  confirm?: unknown;
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

// Gated entrypoint that wraps the backfillRelayfileWritebackCf engine: it
// selects integrations still on the bridge writeback dispatch, pushes their
// credential to relayfile via internal HMAC, and flips the Neon row to "cf".
// dryRun defaults TRUE; an apply requires an explicit typed confirmation so a
// stray request can never mutate prod. Auth mirrors the relaycron-keyed
// internal routes (e.g. sandbox-reaper).
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasRelaycronSecret(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await request
    .json()
    .catch(() => null)) as BackfillRequest | null;

  const dryRun = body?.dryRun !== false;
  if (!dryRun && body?.confirm !== APPLY_CONFIRMATION) {
    return NextResponse.json(
      {
        ok: false,
        error: `confirmation required: set confirm to ${APPLY_CONFIRMATION} to apply`,
      },
      { status: 400 },
    );
  }

  const provider = nonEmptyString(body?.provider);
  const workspaceId = nonEmptyString(body?.workspaceId);
  const limit = positiveInteger(body?.limit);
  const timeoutMs = positiveInteger(body?.timeoutMs);

  const summary = await backfillRelayfileWritebackCf({
    dryRun,
    ...(provider ? { provider } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  return NextResponse.json({ ok: true, data: summary });
}
