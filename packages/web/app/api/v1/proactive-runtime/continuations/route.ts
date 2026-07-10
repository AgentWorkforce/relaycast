import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";

import {
  requireAuthScope,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { agents, workspaces } from "@/lib/db/schema";
import { PostgresContinuationStore } from "@/lib/proactive-runtime/continuation-adapters";
import {
  parseSlackReplyMessagePath,
  slackUserReplyCorrelationKey,
} from "@/lib/proactive-runtime/continuation-correlation";
import { createSlackUserReplyContinuation } from "@/lib/proactive-runtime/continuation-create";
import { isProactiveContinuationResumeEnabled } from "@/lib/proactive-runtime/continuation-flags";
import { verifySlackReplyContextInRelayWorkspace } from "@/lib/proactive-runtime/continuation-slack-context";
import {
  normalizeRelayWorkspaceIdToAppWorkspaceId,
  readBoundRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

type ContinuationCreateBody = {
  originTurnId: string;
  slackReplyPath: string;
  userId: string;
  question?: string;
  sessionId?: string;
  threadId?: string;
  expiresAt?: string;
  maxResumeAttempts?: number;
  metadata?: Record<string, unknown>;
};

type ParsedBody =
  | { ok: true; body: ContinuationCreateBody }
  | { ok: false; error: string };

type SponsorAgent = {
  id: string;
  workspaceId: string;
  deployedName: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  const parsed = readString(value);
  if (!parsed) return { ok: false, error: `invalid_${fieldName}` };
  return { ok: true, value: parsed };
}

function readOptionalExpiresAt(
  value: unknown,
): { ok: true; value?: string } | { ok: false; error: string } {
  const parsed = readOptionalString(value, "expiresAt");
  if (!parsed.ok || !parsed.value) return parsed;
  const millis = Date.parse(parsed.value);
  if (!Number.isFinite(millis)) {
    return { ok: false, error: "invalid_expiresAt" };
  }
  if (millis <= Date.now()) {
    return { ok: false, error: "invalid_expiresAt" };
  }
  return { ok: true, value: new Date(millis).toISOString() };
}

function readOptionalMaxResumeAttempts(
  value: unknown,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return { ok: false, error: "invalid_maxResumeAttempts" };
  }
  return { ok: true, value };
}

function parseBody(value: unknown): ParsedBody {
  if (!isRecord(value)) return { ok: false, error: "invalid_request_body" };
  const originTurnId = readString(value.originTurnId);
  const slackReplyPath = readString(value.slackReplyPath);
  const userId = readString(value.userId);
  if (!originTurnId || !slackReplyPath || !userId) {
    return { ok: false, error: "invalid_request_body" };
  }
  const question = readOptionalString(value.question, "question");
  const sessionId = readOptionalString(value.sessionId, "sessionId");
  const threadId = readOptionalString(value.threadId, "threadId");
  const expiresAt = readOptionalExpiresAt(value.expiresAt);
  const maxResumeAttempts = readOptionalMaxResumeAttempts(
    value.maxResumeAttempts,
  );
  if (!question.ok) return question;
  if (!sessionId.ok) return sessionId;
  if (!threadId.ok) return threadId;
  if (!expiresAt.ok) return expiresAt;
  if (!maxResumeAttempts.ok) return maxResumeAttempts;
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return { ok: false, error: "invalid_metadata" };
  }
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    ok: true,
    body: {
      originTurnId,
      slackReplyPath,
      userId,
      ...(question.value ? { question: question.value } : {}),
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
      ...(threadId.value ? { threadId: threadId.value } : {}),
      ...(expiresAt.value ? { expiresAt: expiresAt.value } : {}),
      ...(maxResumeAttempts.value !== undefined
        ? { maxResumeAttempts: maxResumeAttempts.value }
        : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

function canCreateContinuation(auth: RequestAuth | null): auth is RequestAuth {
  if (!auth) return false;
  if (auth.source !== "relayfile" || !auth.relayfileSponsorId) return false;
  return requireAuthScope(auth, "workflow:invoke:write");
}

async function resolveSponsorAgent(input: {
  auth: RequestAuth;
  appWorkspaceId: string;
}): Promise<SponsorAgent | null> {
  if (!input.auth.relayfileSponsorId) {
    return null;
  }
  const rows = await getDb()
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      deployedName: agents.deployedName,
    })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(
      and(
        eq(agents.id, input.auth.relayfileSponsorId),
        eq(agents.workspaceId, input.appWorkspaceId),
        eq(workspaces.id, input.appWorkspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.id || !row.workspaceId || !row.deployedName) {
    return null;
  }
  return row;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isProactiveContinuationResumeEnabled()) {
    return NextResponse.json(
      { ok: false, error: "continuations_disabled" },
      { status: 404 },
    );
  }

  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (!canCreateContinuation(auth)) {
    return NextResponse.json(
      { ok: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsedBody = parseBody(rawBody);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { ok: false, error: parsedBody.error },
      { status: 400 },
    );
  }
  const body = parsedBody.body;

  const appWorkspaceId = await normalizeRelayWorkspaceIdToAppWorkspaceId(
    auth.workspaceId,
  );
  if (!appWorkspaceId) {
    return NextResponse.json(
      { ok: false, error: "workspace_not_found" },
      { status: 404 },
    );
  }

  const sponsor = await resolveSponsorAgent({ auth, appWorkspaceId });
  if (!sponsor) {
    return NextResponse.json(
      { ok: false, error: "sponsor_forbidden" },
      { status: 403 },
    );
  }

  const relayWorkspaceId = await readBoundRelayWorkspaceId(appWorkspaceId);
  if (!relayWorkspaceId) {
    return NextResponse.json(
      { ok: false, error: "relay_workspace_not_found" },
      { status: 404 },
    );
  }

  const slackPath = parseSlackReplyMessagePath(body.slackReplyPath);
  if (!slackPath) {
    return NextResponse.json(
      { ok: false, error: "invalid_slack_reply_path" },
      { status: 400 },
    );
  }
  const verifiedSlack = await verifySlackReplyContextInRelayWorkspace({
    relayWorkspaceId,
    path: body.slackReplyPath,
    channel: slackPath.channel,
    thread: slackPath.thread,
  });
  if (!verifiedSlack) {
    return NextResponse.json(
      { ok: false, error: "slack_context_forbidden" },
      { status: 403 },
    );
  }

  const slack = {
    channel: verifiedSlack.channel,
    thread: verifiedSlack.thread,
    user: body.userId,
  };
  const { continuation, correlationKey } =
    await createSlackUserReplyContinuation({
      store: new PostgresContinuationStore(),
      assistantId: sponsor.id,
      originTurnId: body.originTurnId,
      slack,
      userId: body.userId,
      sessionId:
        body.sessionId ??
        `slack:${verifiedSlack.channel}:${verifiedSlack.thread}`,
      threadId:
        body.threadId ??
        `slack:channel:${verifiedSlack.channel}:thread:${verifiedSlack.thread}`,
      question: body.question,
      ...(body.expiresAt || body.maxResumeAttempts !== undefined
        ? {
            bounds: {
              ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
              ...(body.maxResumeAttempts !== undefined
                ? { maxResumeAttempts: body.maxResumeAttempts }
                : {}),
            },
          }
        : {}),
      metadata: {
        ...(body.metadata ?? {}),
        workspaceId: appWorkspaceId,
        relayWorkspaceId,
        relayfileSponsorId: sponsor.id,
        slackReplyPath: verifiedSlack.path,
        correlationKey: slackUserReplyCorrelationKey(slack),
      },
    });

  return NextResponse.json({
    ok: true,
    continuationId: continuation.id,
    correlationKey,
    waitFor: continuation.waitFor,
  });
}
