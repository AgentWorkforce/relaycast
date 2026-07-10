import { NextRequest, NextResponse } from "next/server";
import {
  handleRelayfileProviderWriteback,
  isRelayfileWritebackInput,
} from "../../../../../lib/integrations/relayfile-writeback-bridge";
import { verifyRelayfileInternalRequest } from "../../../../../lib/integrations/relayfile-writeback-auth";
import { dispatchMovedToCloudflare } from "./dispatch-moved";

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
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isRelayfileWritebackInput(body)) {
    return NextResponse.json({ error: "Invalid writeback payload" }, { status: 400 });
  }

  if (await dispatchMovedToCloudflare(body)) {
    return NextResponse.json(
      { error: "dispatch_moved", dispatch: "cf" },
      { status: 410 },
    );
  }

  const result = await handleRelayfileProviderWriteback(body);
  return NextResponse.json(result, {
    status: result.outcome === "retryable_failure" ? 502 : 200,
  });
}
