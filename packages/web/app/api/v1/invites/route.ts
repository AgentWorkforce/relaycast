import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth, requireSessionAuth } from "@/lib/auth/request-auth";
import { createInvite, listPendingInvites, requireOrgOwner } from "@/lib/invites/invite-store";
import { sendInviteEmail } from "@/lib/invites/send-invite-email";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isOwner = await requireOrgOwner(auth.organizationId, auth.userId);
  if (!isOwner) {
    return NextResponse.json({ error: "Only organization owners can view invites" }, { status: 403 });
  }

  const invites = await listPendingInvites(auth.organizationId);
  return NextResponse.json({ invites });
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { email?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  const role = body.role ?? "member";
  if (!["member", "owner"].includes(role)) {
    return NextResponse.json({ error: "Role must be 'member' or 'owner'" }, { status: 400 });
  }

  try {
    const appOrigin = getConfiguredAppOrigin();
    const invite = await createInvite({
      organizationId: auth.organizationId,
      email,
      role,
      invitedByUserId: auth.userId,
    });

    const baseUrl = toAbsoluteAppUrl(appOrigin, "/").toString();

    try {
      await sendInviteEmail({
        to: email,
        organizationName: invite.organizationName,
        inviterName: invite.invitedByName,
        inviteToken: invite.token,
        baseUrl,
      });
    } catch (emailError) {
      console.error("Failed to send invite email:", emailError);
      // Invite is still created even if email fails — they can copy the link
    }

    return NextResponse.json({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create invite";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
