"use client";

import { toAppPath } from "@/lib/app-path";
import type { NangoConnectResult } from "./use-nango-connect";

export type GithubInstallationMatch = {
  installationId: string;
  accountLogin: string | null;
  accountType: "Organization" | "User" | "unknown" | string;
  suspended: boolean;
  alreadyConnected: boolean;
};

export type GithubReconcileResponse = {
  userLogin: string | null;
  orgCount: number;
  matches: GithubInstallationMatch[];
  workspaceHasGithub: boolean;
  fallthrough: string;
};

export type GithubLandingWorkspace = {
  id: string;
  slug: string | null;
  name: string | null;
};

export type GithubJoinResponse = {
  action: "join";
  outcome: "pending_approval" | "joined" | "already_member" | string;
  organization?: { id: string; slug?: string | null; name?: string | null };
  installation?: GithubInstallationMatch;
  joinRequest?: { id: string; status: string; createdAt?: string };
  membership?: { role: string; status: string };
  landingWorkspace?: GithubLandingWorkspace | null;
  workspaceSelection?: { ambiguous: true; candidateWorkspaceIds: string[] };
};

export type GithubLinkResponse = {
  action: "link";
  outcome: "linked" | "already_linked" | string;
  organization?: { id: string; slug?: string | null; name?: string | null };
  installation?: GithubInstallationMatch;
  organizationInstallation?: { installationId: string; isPrimary: boolean };
};

export type GithubInstallationFlowMetadata =
  | { enabled: false }
  | {
    enabled: true;
    oauthProviderConfigKey: string;
    reconcileUrl: string;
    installProviderConfigKey: string;
  };

export type ConnectSessionPayload = {
  token?: string;
  sessionToken?: string;
  connectLink?: string;
  connectionId?: string;
  backendIntegrationId?: string;
  githubInstallationFlow?: GithubInstallationFlowMetadata;
};

export type GithubInstallationBranch =
  | {
    kind: "disabled";
    session: ConnectSessionPayload;
  }
  | {
    kind: "install";
    session: ConnectSessionPayload;
    oauthConnectionId?: string;
    reconcile?: GithubReconcileResponse;
    reason: "flag_off" | "no_match" | "personal_install" | "suspended";
  }
  | {
    kind: "inherit";
    oauthConnectionId: string;
    reconcile: GithubReconcileResponse;
    match: GithubInstallationMatch;
  };

export type GithubJoinOutcome =
  | { kind: "connected"; response: GithubJoinResponse; landingWorkspace: GithubLandingWorkspace }
  | { kind: "ambiguous"; response: GithubJoinResponse; candidateWorkspaceIds: string[] }
  | { kind: "pending"; response: GithubJoinResponse }
  | { kind: "no_workspace"; response: GithubJoinResponse; message: string }
  | { kind: "non_joinable"; code: string; message: string };

export async function requestGithubConnectSession(input: {
  workspaceId: string;
  providerConfigKey: string;
  githubInstallationFlow?: boolean;
}): Promise<ConnectSessionPayload> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/connect-session`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowedIntegrations: [input.providerConfigKey],
        ...(input.githubInstallationFlow ? { githubInstallationFlow: true } : {}),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to create connect session."));
  }

  return await response.json() as ConnectSessionPayload;
}

export async function resolveGithubInstallationBranch(input: {
  workspaceId: string;
  providerConfigKey: string;
  openConnectUi: (sessionToken: string) => Promise<NangoConnectResult>;
}): Promise<GithubInstallationBranch> {
  const session = await requestGithubConnectSession({
    workspaceId: input.workspaceId,
    providerConfigKey: input.providerConfigKey,
    githubInstallationFlow: true,
  });
  const flow = session.githubInstallationFlow;
  if (!flow?.enabled) {
    return { kind: "disabled", session };
  }

  const token = readSessionToken(session);
  if (!token) throw new Error("Failed to create GitHub user authorization session.");

  const oauthResult = await input.openConnectUi(token);
  const reconcile = await reconcileGithubInstallation({
    workspaceId: input.workspaceId,
    oauthConnectionId: oauthResult.connectionId,
  });
  const match = selectInheritableMatch(reconcile.matches);
  if (!match) {
    const blocked = reconcile.matches[0];
    return {
      kind: "install",
      session,
      oauthConnectionId: oauthResult.connectionId,
      reconcile,
      reason: blocked?.accountType === "User"
        ? "personal_install"
        : blocked?.suspended
          ? "suspended"
          : "no_match",
    };
  }

  return {
    kind: "inherit",
    oauthConnectionId: oauthResult.connectionId,
    reconcile,
    match,
  };
}

export async function reconcileGithubInstallation(input: {
  workspaceId: string;
  oauthConnectionId?: string;
}): Promise<GithubReconcileResponse> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/github/reconcile`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        input.oauthConnectionId ? { oauthConnectionId: input.oauthConnectionId } : {},
      ),
    },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to reconcile GitHub installations."));
  }
  return await response.json() as GithubReconcileResponse;
}

export async function joinGithubInstallation(input: {
  workspaceId: string;
  installationId: string;
  oauthConnectionId?: string;
}): Promise<GithubJoinOutcome> {
  const response = await postGithubAction<GithubJoinResponse>({
    workspaceId: input.workspaceId,
    action: "join",
    installationId: input.installationId,
    oauthConnectionId: input.oauthConnectionId,
  });

  if (!response.ok) {
    return {
      kind: "non_joinable",
      code: response.code,
      message: response.message,
    };
  }

  const body = response.body;
  if (
    (body.outcome === "joined" || body.outcome === "already_member") &&
    body.landingWorkspace
  ) {
    return { kind: "connected", response: body, landingWorkspace: body.landingWorkspace };
  }
  if (
    (body.outcome === "joined" || body.outcome === "already_member") &&
    body.workspaceSelection?.ambiguous
  ) {
    if (body.workspaceSelection.candidateWorkspaceIds.length === 0) {
      return {
        kind: "no_workspace",
        response: body,
        message: "No destination workspace is available. Contact an organization admin.",
      };
    }
    return {
      kind: "ambiguous",
      response: body,
      candidateWorkspaceIds: body.workspaceSelection.candidateWorkspaceIds,
    };
  }
  if (body.outcome === "pending_approval") {
    return { kind: "pending", response: body };
  }

  return {
    kind: "non_joinable",
    code: "join_unavailable",
    message: "GitHub installation could not be joined.",
  };
}

export async function linkGithubInstallation(input: {
  workspaceId: string;
  installationId: string;
  oauthConnectionId?: string;
}): Promise<GithubLinkResponse> {
  const response = await postGithubAction<GithubLinkResponse>({
    workspaceId: input.workspaceId,
    action: "link",
    installationId: input.installationId,
    oauthConnectionId: input.oauthConnectionId,
  });
  if (!response.ok) {
    throw new Error(response.message);
  }
  return response.body;
}

export function readSessionToken(session: ConnectSessionPayload): string | null {
  return session.token ?? session.sessionToken ?? null;
}

export function selectInheritableMatch(
  matches: GithubInstallationMatch[],
): GithubInstallationMatch | null {
  return matches.find(
    (match) => match.accountType === "Organization" && !match.suspended,
  ) ?? null;
}

async function postGithubAction<T>(input: {
  workspaceId: string;
  action: "join" | "link";
  installationId: string;
  oauthConnectionId?: string;
}): Promise<{ ok: true; body: T } | { ok: false; code: string; message: string }> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/github/${input.action}`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: input.installationId,
        ...(input.oauthConnectionId ? { oauthConnectionId: input.oauthConnectionId } : {}),
      }),
    },
  );
  if (!response.ok) {
    return {
      ok: false,
      code: await readErrorCode(response),
      message: await readErrorMessage(response, "GitHub installation action failed."),
    };
  }
  return { ok: true, body: await response.json() as T };
}

async function readErrorCode(response: Response): Promise<string> {
  const text = await response.clone().text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { code?: unknown; error?: unknown };
    return typeof payload.code === "string"
      ? payload.code
      : typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.message || payload.error || fallback;
  } catch {
    return text;
  }
}
