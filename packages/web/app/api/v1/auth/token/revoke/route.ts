import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, revokeApiTokenSessionByAnyToken } from "@/lib/auth/api-token-store";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: string } | null;
  const bodyToken = body?.token?.trim() || null;
  const headerToken = readBearerToken(request.headers.get("authorization"));
  const token = bodyToken ?? headerToken;

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const revoked = await revokeApiTokenSessionByAnyToken(token, "user_requested");
  if (!revoked) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json({ revoked: true });
}
