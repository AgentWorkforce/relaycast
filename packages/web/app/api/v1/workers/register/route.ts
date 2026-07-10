import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { consumeRateLimit } from "@/lib/workers/rate-limit";
import { extractRequestIp, redeemEnrollmentToken } from "@/lib/workers/tokens";

const HEARTBEAT_INTERVAL_MS = 30_000;

type RegisterBody = {
  enrollmentToken: string;
  name: string;
  hostInfo?: Record<string, unknown>;
};

function isRegisterBody(payload: unknown): payload is RegisterBody {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const body = payload as Partial<RegisterBody>;
  return (
    typeof body.enrollmentToken === "string" &&
    body.enrollmentToken.trim().length > 0 &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    body.name.trim().length <= 128 &&
    (body.hostInfo === undefined ||
      (typeof body.hostInfo === "object" && body.hostInfo !== null && !Array.isArray(body.hostInfo)))
  );
}

function isUniqueConstraintError(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("code" in error || "constraint" in error) &&
    (String((error as { code?: unknown }).code) === "23505" ||
      String((error as { constraint?: unknown }).constraint) === constraint)
  );
}

export async function POST(request: NextRequest) {
  const ip = extractRequestIp(request) ?? "unknown";
  const rateLimit = consumeRateLimit(`worker-register:${ip}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": `${Math.ceil(rateLimit.retryAfterMs / 1000)}`,
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isRegisterBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const { workerId, workerToken } = await redeemEnrollmentToken(
      getDb(),
      body.enrollmentToken.trim(),
      {
        name: body.name.trim(),
        hostInfo: body.hostInfo,
        ip,
      },
    );

    return NextResponse.json({
      workerId,
      workerToken,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid enrollment token") {
      return NextResponse.json({ error: "Invalid enrollment token" }, { status: 401 });
    }

    if (isUniqueConstraintError(error, "workers_workspace_name_unique")) {
      return NextResponse.json({ error: "Worker name already exists" }, { status: 409 });
    }

    console.error(
      "Worker registration failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
