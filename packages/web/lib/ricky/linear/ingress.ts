import { and, eq } from "drizzle-orm";
import { providerCredentials } from "@/lib/db/schema";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { getDb } from "@/lib/db";
import { listWorkspaceIntegrationsByProviderAlias } from "@/lib/integrations/workspace-integrations";
import { rickyRunStore } from "@/lib/ricky/run-store";
import { rickyRunSupervisor } from "@/lib/ricky/run-supervisor";
import { createDelegatedCloudRequest, resolveRickyLinearCloudUser, type RickyLinearSessionAuth } from "./auth";
import { rickyLinearEgress } from "./egress";
import { rickyLinearStore } from "./store";
import {
  buildLinearWorkflow,
  parseGitHubInstallRepositoryId,
  parseRepoTargetFromText,
  type LinearRepoTarget,
} from "./workflow-builder-input";

export type LinearAgentSessionEvent = {
  type?: string;
  action?: string;
  webhookId?: string;
  organizationId?: string;
  linearOrgId?: string;
  appUserId?: string | null;
  app_user_id?: string | null;
  actor?: { id?: string | null };
  user?: { id?: string | null };
  agentSession?: {
    id?: string;
    creatorId?: string | null;
    creator?: { id?: string | null } | null;
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      description?: string | null;
    } | null;
  };
  agentActivity?: {
    userId?: string | null;
    user_id?: string | null;
    user?: { id?: string | null } | null;
    body?: string | null;
    content?: { body?: string | null } | null;
  } | null;
  promptContext?: string | null;
};

type LinearSessionContext = {
  linearOrgId: string;
  linearUserId: string;
  sessionId: string;
  issueTitle: string;
  issueBody: string;
  promptContext?: string;
};

function resolveAppOrigin(explicit?: string): string {
  if (explicit) return new URL(explicit).origin;
  return getConfiguredAppOrigin();
}

function getEventKind(event: LinearAgentSessionEvent): string | null {
  if (event.type === "AgentSessionEvent" && event.action) return event.action;
  return event.type ?? event.action ?? null;
}

function getBodyText(event: LinearAgentSessionEvent): string {
  return [
    event.agentSession?.issue?.description ?? "",
    event.promptContext ?? "",
    event.agentActivity?.body ?? event.agentActivity?.content?.body ?? "",
  ].filter(Boolean).join("\n\n");
}

function parseSessionContext(event: LinearAgentSessionEvent): LinearSessionContext | null {
  const linearOrgId = event.linearOrgId ?? event.organizationId;
  const linearUserId =
    event.agentActivity?.userId ??
    event.agentActivity?.user_id ??
    event.agentActivity?.user?.id ??
    event.agentSession?.creatorId ??
    event.agentSession?.creator?.id ??
    event.actor?.id ??
    event.user?.id ??
    event.appUserId ??
    event.app_user_id;
  const sessionId = event.agentSession?.id;
  if (!linearOrgId || !linearUserId || !sessionId) return null;
  return {
    linearOrgId,
    linearUserId,
    sessionId,
    issueTitle: event.agentSession?.issue?.title ?? event.agentSession?.issue?.identifier ?? "Linear issue",
    issueBody: getBodyText(event),
    ...(event.promptContext ? { promptContext: event.promptContext } : {}),
  };
}

async function listUsableConnectedAgents(auth: RickyLinearSessionAuth) {
  const rows = await getDb()
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, auth.workspaceId),
        eq(providerCredentials.userId, auth.userId),
        eq(providerCredentials.status, "connected"),
      ),
    );
  return rows.filter((row) => ["claude", "opencode", "codex"].includes(row.harness));
}

export async function resolveLinearRepoTarget(input: {
  workspaceId: string;
  issueBody: string;
}): Promise<LinearRepoTarget | null> {
  const fromBody = parseRepoTargetFromText(input.issueBody);
  if (fromBody) return fromBody;
  return parseGitHubInstallRepositoryId(await rickyLinearStore.getWorkspaceDefaultRepositoryId(input.workspaceId));
}

async function hasGithubIntegration(workspaceId: string): Promise<boolean> {
  return (await listWorkspaceIntegrationsByProviderAlias(workspaceId, "github")).length > 0;
}

async function postResponse(input: {
  workspaceId?: string;
  linearOrgId?: string;
  sessionId: string;
  body: string;
  type?: "response" | "elicitation" | "error" | "thought";
  rickyRunId?: string;
}) {
  await rickyLinearEgress.postAgentActivity({
    workspaceId: input.workspaceId,
    linearOrgId: input.linearOrgId,
    sessionId: input.sessionId,
    rickyRunId: input.rickyRunId,
    activity: {
      type: input.type ?? "response",
      body: input.body,
    },
  });
}

export async function handleSessionCreated(input: {
  event: LinearAgentSessionEvent;
  appOrigin?: string;
}): Promise<{ ok: true; status: "launched" | "ignored" | "failed" | "clarification_pending"; rickyRunId?: string }> {
  const session = parseSessionContext(input.event);
  if (!session) return { ok: true, status: "ignored" };

  const origin = resolveAppOrigin(input.appOrigin);

  const resolved = await resolveRickyLinearCloudUser({
    linearOrgId: session.linearOrgId,
    linearUserId: session.linearUserId,
  });
  if (!resolved) {
    await postResponse({
      linearOrgId: session.linearOrgId,
      sessionId: session.sessionId,
      body: `Your Linear identity is not linked to Cloud yet. Connect Ricky Linear from ${new URL("/dashboard/integrations/linear", origin).toString()}.`,
    });
    return { ok: true, status: "failed" };
  }

  const agents = await listUsableConnectedAgents(resolved.auth);
  if (agents.length === 0) {
    await postResponse({
      workspaceId: resolved.auth.workspaceId,
      sessionId: session.sessionId,
      body: `No connected coding agents are available for this Cloud workspace. Connect one from ${new URL("/dashboard/agents", origin).toString()}.`,
    });
    return { ok: true, status: "failed" };
  }

  const repoTarget = await resolveLinearRepoTarget({
    workspaceId: resolved.auth.workspaceId,
    issueBody: session.issueBody,
  });
  if (!repoTarget) {
    await postResponse({
      workspaceId: resolved.auth.workspaceId,
      sessionId: session.sessionId,
      type: "elicitation",
      body: "Which repo should I open the PR against? Reply with `owner/repo`.",
    });
    return { ok: true, status: "clarification_pending" };
  }

  if (!(await hasGithubIntegration(resolved.auth.workspaceId))) {
    await postResponse({
      workspaceId: resolved.auth.workspaceId,
      sessionId: session.sessionId,
      body: `I cannot open a PR until GitHub is connected for this workspace. Connect GitHub from ${new URL("/dashboard/integrations/github", origin).toString()}.`,
    });
    return { ok: true, status: "failed" };
  }

  const workflow = buildLinearWorkflow({
    issueTitle: session.issueTitle,
    issueBody: session.issueBody,
    promptContext: session.promptContext,
    repoTarget,
    connectedAgentCli: agents[0].harness,
  });
  const delegated = createDelegatedCloudRequest({
    url: new URL("/api/v1/ricky/runs", origin).toString(),
    auth: resolved.auth,
  });
  const created = await rickyRunSupervisor.create({
    request: delegated,
    auth: resolved.auth,
    body: {
      workflow,
      fileType: "yaml",
      sourceFileType: "yaml",
      notification: { surface: "none" },
      envSecrets: {
        RICKY_LINEAR_SESSION_ID: session.sessionId,
        RICKY_LINEAR_REPOSITORY: `${repoTarget.owner}/${repoTarget.repo}`,
      },
    },
  });
  await rickyRunStore.appendEvent(created.rickyRunId, "linear.run.started", {
    linearOrgId: session.linearOrgId,
    linearUserId: session.linearUserId,
    sessionId: session.sessionId,
    repoTarget,
  });
  await postResponse({
    workspaceId: resolved.auth.workspaceId,
    sessionId: session.sessionId,
    type: "thought",
    body: `Generated a workflow with 1 step. Running on Cloud now.`,
    rickyRunId: created.rickyRunId,
  });
  await postResponse({
    workspaceId: resolved.auth.workspaceId,
    sessionId: session.sessionId,
    body: `Ricky started a Cloud run: ${new URL(`/dashboard/ricky/${created.rickyRunId}`, origin).toString()}`,
    rickyRunId: created.rickyRunId,
  });

  return { ok: true, status: "launched", rickyRunId: created.rickyRunId };
}

export async function handleSessionPrompted(input: {
  event: LinearAgentSessionEvent;
  appOrigin?: string;
}): Promise<{ ok: true; status: "responded" | "ignored" | "failed" }> {
  const session = parseSessionContext(input.event);
  if (!session) return { ok: true, status: "ignored" };
  const resolved = await resolveRickyLinearCloudUser({
    linearOrgId: session.linearOrgId,
    linearUserId: session.linearUserId,
  });
  if (!resolved) {
    await postResponse({
      linearOrgId: session.linearOrgId,
      sessionId: session.sessionId,
      body: "Your Linear identity is no longer linked to Cloud. Reconnect Ricky Linear in Cloud and try again.",
    });
    return { ok: true, status: "failed" };
  }
  await postResponse({
    workspaceId: resolved.auth.workspaceId,
    sessionId: session.sessionId,
    body: "I'm still working on this. Open the Ricky run viewer in Cloud for the latest status.",
  });
  return { ok: true, status: "responded" };
}

export async function dispatchLinearSessionEvent(input: {
  event: LinearAgentSessionEvent;
  appOrigin?: string;
}) {
  const kind = getEventKind(input.event);
  if (kind === "created") return handleSessionCreated(input);
  if (kind === "prompted") return handleSessionPrompted(input);
  return { ok: true, status: "ignored" as const };
}
