import { NextRequest, NextResponse } from "next/server";
import { resolveInviteByToken } from "@/lib/invites/invite-store";

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  const invite = await resolveInviteByToken(token);

  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  return NextResponse.json({
    invite: {
      id: invite.id,
      organizationName: invite.organizationName,
      email: invite.email,
      role: invite.role,
      invitedByName: invite.invitedByName,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt?.toISOString() ?? null,
      canceledAt: invite.canceledAt?.toISOString() ?? null,
    },
  });
}
