"use client";

import { useEffect, useState, useTransition } from "react";
import type { AuthContext } from "@/lib/auth/types";
import { buildGoogleAuthHref } from "@/lib/auth/google-redirect";
import { toAppPath } from "@/lib/app-path";

type SessionState =
  | { authenticated: false }
  | ({ authenticated: true } & AuthContext);

async function loadSession(): Promise<SessionState> {
  const response = await fetch(toAppPath("/api/auth/session"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return { authenticated: false };
  const payload = (await response.json().catch(() => null)) as SessionState | null;
  return payload ?? { authenticated: false };
}

export function AuthControls() {
  const [session, setSession] = useState<SessionState>({ authenticated: false });
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    loadSession().then((nextSession) => active && setSession(nextSession)).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!session.authenticated) {
    const devLoginEnabled = process.env.NEXT_PUBLIC_SST_STAGE === "development";
    return (
      <div className="flex items-center gap-3">
        <a href={buildGoogleAuthHref("/dashboard")} className="rounded-full border border-transparent bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-fg)] transition-colors hover:bg-[var(--button-primary-hover)]">Sign in with Google</a>
        {devLoginEnabled ? (
          <a href={toAppPath("/api/auth/dev-login")} className="rounded-full border border-[var(--nav-border)] bg-[var(--nav-surface)] px-4 py-2 text-sm font-semibold text-[var(--nav-fg)] transition-colors hover:bg-[var(--nav-surface-hover)]">Dev login</a>
        ) : null}
      </div>
    );
  }

  const organizationMap = new Map(session.organizations.map((organization) => [organization.id, organization]));

  return (
    <div className="flex items-center gap-3">
      <select
        value={session.currentWorkspace.id}
        disabled={pending}
        onChange={(event) => {
          const workspaceId = event.currentTarget.value;
          startTransition(async () => {
            const response = await fetch(toAppPath("/api/auth/workspace"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
            const payload = (await response.json().catch(() => null)) as SessionState | null;
            if (response.ok && payload?.authenticated) setSession(payload);
          });
        }}
        className="max-w-60 rounded-full border border-[var(--nav-border)] bg-[var(--nav-surface)] px-3 py-2 text-sm text-[var(--nav-fg)]"
      >
        {session.organizations.map((organization) => {
          const organizationWorkspaces = session.workspaces.filter((workspace) => workspace.organization_id === organization.id);
          if (!organizationWorkspaces.length) return null;
          return <optgroup key={organization.id} label={organization.name}>{organizationWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</optgroup>;
        })}
      </select>
      <div className="hidden text-sm text-[var(--nav-muted)] md:block">{session.user.name || session.user.email || "Signed in"}{session.currentWorkspace.id && organizationMap.get(session.currentWorkspace.organization_id) ? ` • ${organizationMap.get(session.currentWorkspace.organization_id)?.name}` : ""}</div>
      <button type="button" className="rounded-full border border-[var(--nav-border)] bg-[var(--nav-surface)] px-3 py-2 text-sm text-[var(--nav-fg)] transition-colors hover:border-[var(--nav-border-strong)] hover:bg-[var(--nav-surface-hover)]" onClick={() => { startTransition(async () => { await fetch(toAppPath("/api/auth/logout"), { method: "POST" }); setSession({ authenticated: false }); }); }}>Sign out</button>
    </div>
  );
}
