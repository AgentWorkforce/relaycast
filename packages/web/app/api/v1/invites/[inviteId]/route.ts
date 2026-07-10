import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth, requireSessionAuth } from "@/lib/auth/request-auth";
import { cancelInvite } from "@/lib/invites/invite-store";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { inviteId } = await params;

  try {
    await cancelInvite(inviteId, auth.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to cancel invite";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
