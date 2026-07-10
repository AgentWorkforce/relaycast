import { NextRequest, NextResponse } from "next/server";
import { verifyRelayfileInternalRequest } from "../../../../../lib/integrations/relayfile-writeback-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!verifyRelayfileInternalRequest(request.headers, rawBody)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid audit payload" }, { status: 400 });
  }

  // Emit one log line per event so audit data is at least observable in the
  // logging pipeline. Persistence to a dedicated table is a separate scope
  // decision (see docs/architecture/relayfile-writeback-cf-test-plan.md F3);
  // without that, this is the only place these events become visible.
  console.info("[relayfile] writeback audit batch", { count: body.length });
  for (const event of body) {
    console.info("[relayfile] writeback audit event", { event });
  }
  return NextResponse.json({ accepted: body.length }, { status: 202 });
}
