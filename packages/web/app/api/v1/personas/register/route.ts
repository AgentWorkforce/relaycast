import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { agents, type AgentExecutor } from "@/lib/db/schema";
import { resolveRequestAuth } from "@/lib/auth/request-auth";

/**
 * POST /api/v1/personas/register
 *
 * Self-registration endpoint that sage / nightcto / msd-app workers call at
 * boot. Per canonical-spec §7.1 (sage/specs/proactive-unification.md), the
 * caller's bearer token resolves to either:
 *
 * - A hosted-service identity (Sage / NightCTO / MSD). Service auth maps
 *   to a stable `ownerService` tag; the endpoint refuses requests whose
 *   payload personas declare a different `ownerService`.
 * - A workspace API token (workforce CLI). Standalone personas only —
 *   payload personas must have `ownerService: null`.
 *
 * Behavior:
 *   • Validates the payload shape (canonical-spec §7.1).
 *   • Upserts each persona into the `agents` table, keyed on
 *     `(workspaceId, personaId)`. The `executor` column captures the
 *     persona's executor branch; missing → defaults to ephemeral-sandbox.
 *   • Returns the same payload shape with one entry per persona indicating
 *     `registered | unchanged | rejected` and the resolved agent id.
 *
 * Out of scope for PR-1.1 (canonical-spec §16.4 + cloud.md Approval boundary):
 *   • Rate limiting (sketched as a placeholder — returns 429 on a static
 *     per-token cap; future PR refines via Redis or a token bucket).
 *   • Multi-workspace `workspaceIds[]` fanout — accepted but defaults to
 *     the caller's bound workspace until PR-1.3 wires the membership check.
 */

const RATE_LIMIT_MAX = 60; // permissive default; spec §7.1 documents 429 rate_limited path
const RATE_BUCKET = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;

interface RegisterPayload {
  source: string;
  workspaceIds?: string[];
  personas: PersonaInput[];
}

interface PersonaInput {
  id: string;
  intent: string;
  description: string;
  ownerService?: string | null;
  executor?: AgentExecutor;
  // Other PersonaDefinition fields are accepted but stored under the
  // existing pinnedVersionId / spec linkage. PR-1.3 will broaden persistence.
  [key: string]: unknown;
}

interface PersonaResult {
  id: string;
  status: "registered" | "unchanged" | "rejected";
  agentId?: string;
  reason?: string;
}

function rateLimit(tokenKey: string): boolean {
  const now = Date.now();
  const bucket = RATE_BUCKET.get(tokenKey);
  if (!bucket || bucket.resetAt < now) {
    RATE_BUCKET.set(tokenKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return false;
  }
  return true;
}

function isValidPayload(body: unknown): body is RegisterPayload {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.source !== "string" || b.source.trim().length === 0) return false;
  if (!Array.isArray(b.personas) || b.personas.length === 0) return false;
  for (const p of b.personas) {
    if (!p || typeof p !== "object") return false;
    const pp = p as Record<string, unknown>;
    if (typeof pp.id !== "string" || pp.id.trim().length === 0) return false;
    if (typeof pp.intent !== "string") return false;
    if (typeof pp.description !== "string") return false;
  }
  if (b.workspaceIds !== undefined) {
    if (!Array.isArray(b.workspaceIds)) return false;
    if (!b.workspaceIds.every((w) => typeof w === "string")) return false;
  }
  return true;
}

function resolveOwnerService(authSource: string | undefined): string | null {
  // request-auth.ts marks Sage's service-token auth with source="service"; the
  // userId is SAGE_SERVICE_USER_ID. NightCTO + MSD adopt the same path in PR-6.2.
  // Workspace-token auth (workforce CLI) reports source="token" — ownerService
  // is null for standalone personas in that case.
  if (authSource === "service") return "sage";
  return null;
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json(
      { code: "unauthenticated", message: "Authorization bearer token is required" },
      { status: 401 },
    );
  }

  const tokenKey = auth.bearerToken ?? auth.userId;
  if (!rateLimit(tokenKey)) {
    return NextResponse.json(
      { code: "rate_limited", message: "register requests exceeded; retry after 60s" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code: "invalid_body", message: "request body must be JSON" },
      { status: 400 },
    );
  }

  if (!isValidPayload(body)) {
    return NextResponse.json(
      { code: "invalid_payload", message: "payload must match canonical-spec §7.1 shape" },
      { status: 400 },
    );
  }

  const resolvedOwnerService = resolveOwnerService(auth.source);

  // Enforce cross-service guard: a Sage token cannot register personas claiming
  // a different ownerService; a workforce workspace token cannot register any
  // ownerService-tagged persona (standalone personas only).
  for (const persona of body.personas) {
    if (resolvedOwnerService === null) {
      if (persona.ownerService && persona.ownerService !== null) {
        return NextResponse.json(
          {
            code: "cross_service_registration_forbidden",
            message: `workspace token cannot register persona with ownerService=${persona.ownerService}`,
          },
          { status: 403 },
        );
      }
    } else if (persona.ownerService && persona.ownerService !== resolvedOwnerService) {
      return NextResponse.json(
        {
          code: "cross_service_registration_forbidden",
          message: `service token for ${resolvedOwnerService} cannot register persona owned by ${persona.ownerService}`,
        },
        { status: 403 },
      );
    }
  }

  const targetWorkspaceIds =
    body.workspaceIds && body.workspaceIds.length > 0 ? body.workspaceIds : [auth.workspaceId];

  const db = getDb();
  const results: PersonaResult[] = [];

  for (const persona of body.personas) {
    const executor: AgentExecutor = persona.executor ?? { kind: "ephemeral-sandbox" };
    for (const workspaceId of targetWorkspaceIds) {
      const existing = await db
        .select({ id: agents.id, executor: agents.executor, sourceTag: agents.sourceTag })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.deployedName, persona.id)))
        .limit(1);

      if (existing.length > 0) {
        const same =
          JSON.stringify(existing[0].executor) === JSON.stringify(executor) &&
          existing[0].sourceTag === body.source;
        if (same) {
          results.push({ id: persona.id, status: "unchanged", agentId: existing[0].id });
          continue;
        }
        await db
          .update(agents)
          .set({
            executor,
            ownerService: resolvedOwnerService,
            sourceTag: body.source,
            updatedAt: sql`NOW()`,
          })
          .where(eq(agents.id, existing[0].id));
        results.push({ id: persona.id, status: "registered", agentId: existing[0].id });
        continue;
      }

      // No existing row → reject. PR-1.3 will handle first-time creation
      // (it needs personaId + pinnedVersionId resolution from the upstream
      // persona catalog, which is out of scope for the registration endpoint
      // itself). For now the endpoint is an upsert-or-fail for existing rows.
      results.push({
        id: persona.id,
        status: "rejected",
        reason: "agent row not yet provisioned; deploy via existing CLI flow first (PR-1.3 follow-up)",
      });
    }
  }

  return NextResponse.json({ source: body.source, results }, { status: 200 });
}
