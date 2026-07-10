"use client";

import { useEffect, useState } from "react";
import { toAppPath } from "@/lib/app-path";

/**
 * Lightweight session/workspace resolution for the standalone `/cloud/deploy`
 * wizard. The wizard lives outside the dashboard layout, so it can't use
 * `useDashboard()`; this mirrors the dashboard's session fetch + dev bypass so
 * the page resolves the operator's workspace on its own.
 */

export interface DeployWorkspace {
  id: string;
  slug: string;
  name: string;
  organization_id: string;
}

export interface DeployUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface SessionState {
  authenticated?: boolean;
  user?: DeployUser;
  workspaces?: DeployWorkspace[];
  currentWorkspace?: DeployWorkspace;
}

export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface DeploySession {
  status: SessionStatus;
  user: DeployUser | null;
  workspaces: DeployWorkspace[];
  currentWorkspace: DeployWorkspace | null;
  selectWorkspace: (id: string) => void;
  isDev: boolean;
}

const DEV_WORKSPACE: DeployWorkspace = {
  id: "dev-workspace-id",
  organization_id: "dev-org-id",
  slug: "dev-workspace",
  name: "Dev Workspace",
};

const DEV_USER: DeployUser = {
  id: "dev-user-id",
  email: "dev@localhost",
  name: "Dev User",
  avatarUrl: null,
};

export function useDeploySession(): DeploySession {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<DeployUser | null>(null);
  const [workspaces, setWorkspaces] = useState<DeployWorkspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isDev, setIsDev] = useState(false);

  useEffect(() => {
    let active = true;

    const devBypass =
      process.env.NEXT_PUBLIC_SST_STAGE === "development" &&
      typeof window !== "undefined" &&
      !window.location.hostname.includes("cloud.agentrelay.com");

    if (devBypass) {
      setIsDev(true);
      setStatus("authenticated");
      setUser(DEV_USER);
      setWorkspaces([DEV_WORKSPACE]);
      setCurrentId(DEV_WORKSPACE.id);
      return () => {
        active = false;
      };
    }

    fetch(toAppPath("/api/auth/session"), { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<SessionState>) : null))
      .then((payload) => {
        if (!active) return;
        if (payload?.authenticated && payload.currentWorkspace) {
          setStatus("authenticated");
          setUser(payload.user ?? null);
          setWorkspaces(payload.workspaces ?? [payload.currentWorkspace]);
          setCurrentId(payload.currentWorkspace.id);
        } else {
          setStatus("anonymous");
        }
      })
      .catch(() => {
        if (active) setStatus("anonymous");
      });

    return () => {
      active = false;
    };
  }, []);

  const currentWorkspace =
    workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? null;

  return {
    status,
    user,
    workspaces,
    currentWorkspace,
    selectWorkspace: setCurrentId,
    isDev,
  };
}
