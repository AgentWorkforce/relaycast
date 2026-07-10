import { NextRequest, NextResponse } from "next/server";
import { createAuthSandbox } from "@cloud/core/auth/sandbox-auth.js";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { cliAuthSessionStore } from "@/lib/auth/session-store";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { consumeRateLimit } from "@/lib/workers/rate-limit";

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const rateLimit = consumeRateLimit(`cli-auth:${ip}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        },
      },
    );
  }

  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { provider?: string; language?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { provider, language } = body;
  if (!provider || typeof provider !== "string") {
    return NextResponse.json(
      { error: "Missing required field: provider" },
      { status: 400 }
    );
  }

  let daytonaAuth: ReturnType<typeof resolveServerDaytonaAuthParams>;
  try {
    daytonaAuth = resolveServerDaytonaAuthParams();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Server misconfigured" },
      { status: 500 }
    );
  }

  try {
    const result = await createAuthSandbox({
      provider,
      userId: auth.userId,
      ...daytonaAuth,
      language,
      sessionStore: cliAuthSessionStore,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("CLI auth sandbox creation failed:", message);

    // Return user-safe error; keep internals server-side
    const isUserError = message.startsWith("Unknown provider:");
    return NextResponse.json(
      { error: isUserError ? message : "Failed to create auth sandbox. Please try again." },
      { status: isUserError ? 400 : 500 }
    );
  }
}
