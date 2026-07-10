import { NextRequest, NextResponse } from "next/server";
import { redeemNodeEnrollmentToken } from "@/lib/fleet/nodes";
import { consumeRateLimit } from "@/lib/workers/rate-limit";
import { extractRequestIp } from "@/lib/workers/tokens";

type RegisterBody = {
  enrollmentToken: string;
  name?: string;
  capabilities?: string[];
  maxAgents?: number;
  tags?: string[];
  version?: string;
};

function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function parseBody(payload: unknown): RegisterBody | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Partial<RegisterBody>;
  if (typeof body.enrollmentToken !== "string" || !body.enrollmentToken.trim()) return null;
  const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : null;
  if (name === null || (name !== undefined && name.length > 128)) return null;
  const capabilities = stringList(body.capabilities);
  const tags = stringList(body.tags);
  if (capabilities === null || tags === null) return null;
  const maxAgents = body.maxAgents === undefined
    ? undefined
    : typeof body.maxAgents === "number" && Number.isInteger(body.maxAgents) && body.maxAgents >= 0
      ? body.maxAgents
      : null;
  if (maxAgents === null) return null;
  const version = body.version === undefined ? undefined : typeof body.version === "string" ? body.version.trim() : null;
  if (version === null) return null;
  return {
    enrollmentToken: body.enrollmentToken.trim(),
    ...(name ? { name } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(version ? { version } : {}),
  };
}

export async function POST(request: NextRequest) {
  const ip = extractRequestIp(request) ?? "unknown";
  const rateLimit = consumeRateLimit(`node-register:${ip}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": `${Math.ceil(rateLimit.retryAfterMs / 1000)}` } },
    );
  }

  let body: RegisterBody | null;
  try {
    body = parseBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  try {
    const result = await redeemNodeEnrollmentToken({ ...body, ip });
    return NextResponse.json(
      {
        nodeId: result.nodeId,
        nodeName: result.nodeName,
        nodeToken: result.nodeToken,
        relayWorkspaceId: result.relayWorkspaceId,
        relaycastUrl: result.relaycastUrl,
        websocketUrl: `${result.relaycastUrl}/v1/node/ws`,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid enrollment token") {
      return NextResponse.json({ error: "Invalid enrollment token" }, { status: 401 });
    }
    console.error("Node registration failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
