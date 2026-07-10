import { NextRequest, NextResponse } from "next/server";
import {
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type MemoryScope = "workspace" | "user" | "global";

type SaveBody = {
  scope?: unknown;
  content?: unknown;
  tags?: unknown;
  ttlSeconds?: unknown;
};

const DEFAULT_SUPERMEMORY_BASE_URL = "https://api.supermemory.ai";
const SUPERMEMORY_TIMEOUT_MS = 10_000;

function readSupermemoryApiKey(): string | null {
  return (
    tryResourceValue("SageSupermemoryApiKey")?.trim() ||
    optionalEnv("SUPERMEMORY_API_KEY")?.trim() ||
    null
  );
}

function readSupermemoryBaseUrl(): string {
  return (
    optionalEnv("SUPERMEMORY_BASE_URL")?.trim() ||
    DEFAULT_SUPERMEMORY_BASE_URL
  ).replace(/\/+$/, "");
}

function parseScope(value: unknown): MemoryScope | null {
  const scope = typeof value === "string" && value.trim() ? value.trim() : "workspace";
  return scope === "workspace" || scope === "user" || scope === "global" ? scope : null;
}

function resolveSpace(scope: MemoryScope, workspaceId: string, userId: string): string {
  if (scope === "global") {
    return "agentrelay-global";
  }
  if (scope === "user") {
    return `agentrelay-user-${userId}`;
  }
  return `agentrelay-ws-${workspaceId}`;
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return Math.min(parsed, 50);
}

function hasMemoryRouteAccess(auth: RequestAuth, workspaceId: string): boolean {
  if (requireSessionAuth(auth)) {
    return hasWorkspaceAccess(auth, workspaceId);
  }

  if (
    auth.source === "relayfile" &&
    auth.workspaceId === workspaceId &&
    auth.relayfileSponsorId &&
    auth.scopes?.includes("workflow:invoke:write")
  ) {
    return true;
  }

  // Runtime memory calls are made with deployed sandbox API tokens. Do not let
  // generic workspace-scoped CLI tokens reach this route just because their
  // workspaceId matches.
  return auth.source === "token" && auth.subjectType === "sandbox" && auth.workspaceId === workspaceId;
}

async function requireMemoryAccess(request: NextRequest, workspaceId: string) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return { ok: false as const, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!hasMemoryRouteAccess(auth, workspaceId)) {
    return { ok: false as const, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true as const, auth };
}

function supermemoryHeaders(apiKey: string): HeadersInit {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function readMemoryId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["id", "memoryId", "documentId"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  const nested = record.memory;
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return (nested as { id: string }).id;
  }
  return "";
}

function normalizeRecallItems(payload: unknown): Array<{
  id: string;
  content: string;
  tags: string[];
  createdAt: string | null;
}> {
  const items = Array.isArray((payload as { items?: unknown })?.items)
    ? (payload as { items: unknown[] }).items
    : Array.isArray((payload as { results?: unknown })?.results)
    ? (payload as { results: unknown[] }).results
    : Array.isArray(payload)
    ? payload
    : [];

  return items
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    )
    .map((item) => ({
      id: String(item.id ?? item.memoryId ?? ""),
      content: String(item.content ?? item.text ?? item.chunk ?? ""),
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      createdAt: typeof item.createdAt === "string"
        ? item.createdAt
        : typeof item.created_at === "string"
        ? item.created_at
        : null,
    }))
    .filter((item) => item.id || item.content);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function fetchSupermemory(
  operation: "save" | "recall",
  url: string,
  init: RequestInit,
): Promise<
  | { ok: true; response: Response; payload: unknown }
  | { ok: false; response: NextResponse<{ error: string; code: string }> }
> {
  try {
    const response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(SUPERMEMORY_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    return { ok: true, response, payload };
  } catch (error) {
    const timedOut = isTimeoutError(error);
    console.warn(`[memory] Supermemory ${operation} request failed`, {
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: timedOut ? "Supermemory request timed out" : "Supermemory request failed",
          code: timedOut ? "supermemory_timeout" : "supermemory_unavailable",
        },
        { status: timedOut ? 504 : 502 },
      ),
    };
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireMemoryAccess(request, workspaceId);
  if (!access.ok) {
    return access.response;
  }

  const apiKey = readSupermemoryApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: "Supermemory API key is not configured" }, { status: 503 });
  }

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const scope = parseScope(body.scope);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!scope) {
    return NextResponse.json({ error: "Invalid memory scope" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const upstream = await fetchSupermemory("save", `${readSupermemoryBaseUrl()}/v3/memories`, {
    method: "POST",
    headers: supermemoryHeaders(apiKey),
    body: JSON.stringify({
      content,
      space: resolveSpace(scope, workspaceId, access.auth.userId),
      tags: parseTags(body.tags),
      ttlSeconds: typeof body.ttlSeconds === "number" && body.ttlSeconds > 0
        ? Math.floor(body.ttlSeconds)
        : undefined,
    }),
  });
  if (!upstream.ok) {
    return upstream.response;
  }
  const { response, payload } = upstream;
  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to save memory", details: payload },
      { status: response.status },
    );
  }

  return NextResponse.json({ id: readMemoryId(payload) });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireMemoryAccess(request, workspaceId);
  if (!access.ok) {
    return access.response;
  }

  const scope = parseScope(request.nextUrl.searchParams.get("scope"));
  const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
  if (!scope) {
    return NextResponse.json({ error: "Invalid memory scope" }, { status: 400 });
  }
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const apiKey = readSupermemoryApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: "Supermemory API key is not configured" }, { status: 503 });
  }

  const upstream = await fetchSupermemory("recall", `${readSupermemoryBaseUrl()}/v3/search`, {
    method: "POST",
    headers: supermemoryHeaders(apiKey),
    body: JSON.stringify({
      q: query,
      space: resolveSpace(scope, workspaceId, access.auth.userId),
      limit: parseLimit(request.nextUrl.searchParams.get("limit")),
    }),
  });
  if (!upstream.ok) {
    return upstream.response;
  }
  const { response, payload } = upstream;
  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to recall memory", details: payload },
      { status: response.status },
    );
  }

  return NextResponse.json({ items: normalizeRecallItems(payload) });
}
