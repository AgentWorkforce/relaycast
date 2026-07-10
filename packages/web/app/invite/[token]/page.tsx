"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, use } from "react";
import { buildGoogleAuthHref } from "@/lib/auth/google-redirect";
import { toAppPath } from "@/lib/app-path";
import { Header } from "../../components/Header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../components/ui/card";
import { Button, buttonVariants } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";

type InviteInfo = {
  id: string;
  organizationName: string;
  email: string;
  role: string;
  invitedByName: string;
  expiresAt: string;
  acceptedAt: string | null;
  canceledAt: string | null;
};

type SessionState = {
  authenticated: boolean;
  user?: { email: string | null; name: string | null };
};

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "accepting" | "accepted" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([
      fetch(`${toAppPath("/api/v1/invites/resolve")}?token=${encodeURIComponent(token)}`, {
        credentials: "include",
      }).then((r) => r.json()),
      fetch(toAppPath("/api/auth/session"), { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([inviteData, sessionData]) => {
        if (!active) return;
        if (inviteData.error) {
          setError(inviteData.error);
          setStatus("error");
          return;
        }
        setInvite(inviteData.invite);
        setSession(sessionData);
        setStatus("ready");
      })
      .catch(() => {
        if (active) {
          setError("Failed to load invite details");
          setStatus("error");
        }
      });

    return () => { active = false; };
  }, [token]);

  const handleAccept = async () => {
    setStatus("accepting");
    try {
      const response = await fetch(toAppPath("/api/v1/invites/accept"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Failed to accept invite");
        setStatus("error");
        return;
      }

      setStatus("accepted");
      // Redirect to dashboard after a brief moment
      setTimeout(() => {
        router.push("/dashboard");
      }, 1500);
    } catch {
      setError("Failed to accept invite");
      setStatus("error");
    }
  };

  const isExpired = invite?.expiresAt ? new Date(invite.expiresAt) <= new Date() : false;
  const isInvalid = invite?.acceptedAt || invite?.canceledAt || isExpired;

  return (
    <div className="relative min-h-screen overflow-hidden bg-transparent">
      <Header />
      <main className="relative z-10 mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-20">
        {status === "loading" ? (
          <Card className="w-full">
            <CardContent className="py-12 text-center text-[var(--fg-muted)]">
              Loading invite...
            </CardContent>
          </Card>
        ) : status === "error" ? (
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Unable to join</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
                Go to dashboard
              </Link>
            </CardContent>
          </Card>
        ) : status === "accepted" ? (
          <Card className="w-full">
            <CardContent className="py-12 text-center">
              <p className="text-lg font-medium text-[var(--fg)]">
                You&apos;ve joined {invite?.organizationName}
              </p>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">Redirecting to dashboard...</p>
            </CardContent>
          </Card>
        ) : invite && !isInvalid ? (
          <Card className="w-full">
            <CardHeader>
              <Badge variant="info" className="mb-2 w-fit">Organization invite</Badge>
              <CardTitle>
                Join {invite.organizationName}
              </CardTitle>
              <CardDescription>
                {invite.invitedByName} invited you to join as a {invite.role}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--fg-muted)]">Invited email</span>
                  <span className="text-[var(--fg)]">{invite.email}</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-[var(--fg-muted)]">Role</span>
                  <span className="capitalize text-[var(--fg)]">{invite.role}</span>
                </div>
              </div>

              {!session?.authenticated ? (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--fg-muted)]">Sign in to accept this invitation.</p>
                  <a
                    href={buildGoogleAuthHref(`/invite/${token}`)}
                    className={buttonVariants({ className: "w-full" })}
                  >
                    Sign in with Google
                  </a>
                </div>
              ) : (
                <Button
                  className="w-full"
                  disabled={status === "accepting"}
                  onClick={handleAccept}
                >
                  {status === "accepting" ? "Joining..." : "Accept invitation"}
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Invite unavailable</CardTitle>
              <CardDescription>
                {invite?.acceptedAt
                  ? "This invite has already been accepted."
                  : invite?.canceledAt
                    ? "This invite has been canceled."
                    : "This invite has expired."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
                Go to dashboard
              </Link>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
