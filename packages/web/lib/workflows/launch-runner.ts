import { Resource } from "sst";
import { eq, and } from "drizzle-orm";
import {
  deriveInteractive,
  WorkflowSandboxProvisioningPendingError,
} from "@cloud/core/bootstrap/launcher.js";
import {
  mintCredentialProxyToken,
  resolveProxyProviderFromCredentialProvider,
} from "@cloud/core/auth/proxy-token.js";
import {
  buildCredentialBundle,
  getAllProviders,
  getCliCredentials,
  launchOrchestratorSandbox,
  listConnectedProviders,
  resolveCredentialProxyConfig,
  workflowNeedsCliCredentials,
} from "../workflows";
import { mintScopedS3Credentials } from "../aws/sts-credentials";
import { isWorkerRuntime } from "../aws/runtime";
import {
  buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend,
} from "../storage";
import {
  attachSandboxToApiTokenSession,
  createApiTokenSession,
  revokeApiTokenSessionById,
} from "../auth/api-token-store";
import { getBrokerKeySecret } from "../auth/secrets";
import { resolveServerDaytonaAuthParams } from "../daytona-auth";
import { getDb } from "../db";
import { agents, sandboxes, workspaces } from "../db/schema";
import { optionalEnv } from "../env";
import { toAbsoluteAppUrl } from "../app-path";
import { resolveRelayfileConfig } from "../relayfile";
import { ensureRelayWorkspace } from "../relay-workspaces";
import {
  mintWorkflowGithubWriteToken,
  WorkflowGithubWriteTokenError,
} from "../integrations/github-workflow-write-token";
import { resolveOrProvisionRelayWorkspace } from "./relay-workspace";
import { resolveRelaycastUrl } from "../workspace-registry";
import type { WorkflowLaunchEnvelope } from "./launch-job-envelope";

export type WorkflowLaunchRunnerResult = {
  sandboxId: string;
  launchedExecutionMode: "per-step-sandbox" | "shared-sandbox";
  launchedObserverUrl: string;
  launchedWorkdir: string;
  relayWorkspaceId: string;
};

export type WorkflowLaunchErrorKind = "terminal" | "retryable";

export class WorkflowLaunchError extends Error {
  readonly kind: WorkflowLaunchErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(
    kind: WorkflowLaunchErrorKind,
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkflowLaunchError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
  }
}

function safeWorkflowStorageResource(prop: "bucketName" | "stsRoleArn"): string | undefined {
  try {
    const resource = Resource.WorkflowStorage as unknown as Record<string, unknown>;
    const value = resource?.[prop];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveLinkedSecret(name: string, fallbackEnvVar: string): string | undefined {
  let linked: string | undefined;
  try {
    linked = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    linked = undefined;
  }
  return linked && linked.length > 0 ? linked : optionalEnv(fallbackEnvVar);
}

function extractAgentClisFromScript(source: string): string[] {
  const cliPattern = /cli:\s*["']([a-z]+)["']/g;
  const clis = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = cliPattern.exec(source)) !== null) {
    clis.add(match[1]);
  }

  return [...clis];
}

async function resolveRelayfileSponsorDeployedName(input: {
  workspaceId: string;
  relayfileSponsorId: string;
}): Promise<string | null> {
  try {
    const rows = await getDb()
      .select({ deployedName: agents.deployedName })
      .from(agents)
      .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(
        and(
          eq(agents.id, input.relayfileSponsorId),
          eq(agents.workspaceId, input.workspaceId),
          eq(workspaces.id, input.workspaceId),
        ),
      )
      .limit(1);
    const deployedName = rows[0]?.deployedName;
    return typeof deployedName === "string" && deployedName.length > 0 ? deployedName : null;
  } catch (error) {
    console.warn("[workflow-launch] could not resolve relayfile sponsor deployedName", {
      workspaceId: input.workspaceId,
      relayfileSponsorId: input.relayfileSponsorId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function maybeInjectWorkflowGithubWriteToken(
  envelope: WorkflowLaunchEnvelope,
): Promise<Record<string, string> | undefined> {
  const grant = envelope.githubWrite;
  if (!grant) return envelope.envSecrets;

  const envTokenNames = grant.envTokenNames ?? [];
  if (envTokenNames.length === 0) {
    console.log("[workflow-launch] registered GitHub write grant does not request sandbox token injection", {
      runId: envelope.runId,
      workspaceId: envelope.workspaceId,
      invocationSlug: grant.slug,
      repo: `${grant.owner}/${grant.repo}`,
    });
    return envelope.envSecrets;
  }

  const sponsorDeployedName = await resolveRelayfileSponsorDeployedName({
    workspaceId: envelope.workspaceId,
    relayfileSponsorId: grant.relayfileSponsorId,
  });
  if (sponsorDeployedName !== grant.slug) {
    throw new WorkflowLaunchError(
      "terminal",
      "Registered GitHub-write workflows require the matching deployed persona sponsor.",
      { status: 403, code: "github_write_forbidden" },
    );
  }

  try {
    const minted = await mintWorkflowGithubWriteToken({
      userId: envelope.workflowOwnerUserId,
      workspaceId: envelope.workspaceId,
      repoOwner: grant.owner,
      repoName: grant.repo,
    });
    const merged = { ...(envelope.envSecrets ?? {}) };
    for (const envName of envTokenNames) {
      merged[envName] = minted.token;
    }
    console.log("[workflow-launch] minted GitHub write token for registered workflow", {
      runId: envelope.runId,
      workspaceId: envelope.workspaceId,
      invocationSlug: grant.slug,
      repo: `${grant.owner}/${grant.repo}`,
      installationId: minted.installationId,
      repositoryScoped: minted.repositoryScoped,
    });
    return merged;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[workflow-launch] GitHub write token mint failed", {
      runId: envelope.runId,
      workspaceId: envelope.workspaceId,
      invocationSlug: grant.slug,
      repo: `${grant.owner}/${grant.repo}`,
      code: error instanceof WorkflowGithubWriteTokenError ? error.code : "unexpected",
      message,
    });
    if (error instanceof WorkflowGithubWriteTokenError) {
      throw new WorkflowLaunchError(
        error.status >= 500 ? "retryable" : "terminal",
        message,
        { status: error.status, code: error.code, cause: error },
      );
    }
    throw new WorkflowLaunchError("retryable", message, {
      status: 503,
      code: "github_write_token_unavailable",
      cause: error,
    });
  }
}

export async function runWorkflowLaunch(input: {
  envelope: WorkflowLaunchEnvelope;
  onSandboxCreated?: (sandboxId: string) => Promise<void> | void;
  provisioningSandboxId?: string | null;
}): Promise<WorkflowLaunchRunnerResult> {
  const envelope = input.envelope;
  let tokenSessionId: string | null = null;
  let sandboxRegistered = false;
  let sandboxIdForFailure: string | null = null;
  let persistedProvisioningSandboxId: string | null = input.provisioningSandboxId?.trim() || null;

  try {
    const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
    if (!relayfileUrl || !relayAuthApiKey) {
      throw new WorkflowLaunchError("terminal", "Workflow launch misconfigured: missing relayfile configuration.", {
        status: 500,
        code: "relayfile_config_missing",
      });
    }

    const apiUrl = toAbsoluteAppUrl(envelope.appOrigin, "/").toString();
    const observerUrl = toAbsoluteAppUrl(envelope.appOrigin, `/runs/${envelope.runId}`).toString();
    const orchestratorLibUrl = toAbsoluteAppUrl(envelope.appOrigin, "/orchestrator-lib.tar.gz").toString();
    const callbackUrl = toAbsoluteAppUrl(envelope.appOrigin, "/api/v1/workflows/callback").toString();
    const credentialProxyUrl = optionalEnv("CREDENTIAL_PROXY_URL");
    const credentialProxyJwtSecret = resolveLinkedSecret(
      "CredentialProxyJwtSecret",
      "CREDENTIAL_PROXY_JWT_SECRET",
    );
    const credentialProxyEnabled = Boolean(credentialProxyUrl && credentialProxyJwtSecret);

    let cliCredentials = "";
    const credentialProxyTokens: Record<string, string> = {};
    const isConfigWorkflow = envelope.fileType === "yaml";
    const needsCli = isConfigWorkflow ? workflowNeedsCliCredentials(envelope.workflow) : true;
    if (needsCli) {
      const providers = isConfigWorkflow
        ? getAllProviders(envelope.workflow)
        : await listConnectedProviders(
          envelope.workflowOwnerUserId,
          Resource.CredentialEncryptionKey.value,
        );

      if (!isConfigWorkflow && providers.length === 0) {
        throw new WorkflowLaunchError(
          "terminal",
          "No CLI credentials connected. Run 'agent-relay cloud connect <provider>' first.",
          { status: 400, code: "cli_credentials_missing" },
        );
      }

      const rawCredentialBundle: Record<string, string> = {};
      for (const provider of providers) {
        const proxyProvider = credentialProxyEnabled
          ? resolveProxyProviderFromCredentialProvider(provider)
          : undefined;

        if (proxyProvider && credentialProxyJwtSecret) {
          credentialProxyTokens[proxyProvider] ??= await mintCredentialProxyToken({
            subject: envelope.workspaceId,
            provider: proxyProvider,
            credentialId: envelope.workflowOwnerUserId,
            secret: credentialProxyJwtSecret,
            ttlSeconds: 2 * 60 * 60,
          });
          continue;
        }

        try {
          rawCredentialBundle[provider] = await getCliCredentials(
            envelope.workflowOwnerUserId,
            provider,
            Resource.CredentialEncryptionKey.value,
          );
        } catch {
          // Provider credentials not found — skip (step will fail if needed)
        }
      }

      const rawProviders = Object.keys(rawCredentialBundle);
      if (rawProviders.length === 1) {
        cliCredentials = rawCredentialBundle[rawProviders[0]];
      } else if (rawProviders.length > 1) {
        cliCredentials = JSON.stringify(rawCredentialBundle);
      }
    }

    const storageBackend = getWorkflowStorageBackend();
    const roleArn = storageBackend === "s3" ? safeWorkflowStorageResource("stsRoleArn") : undefined;
    const bucket = storageBackend === "s3" ? safeWorkflowStorageResource("bucketName") : undefined;
    if (storageBackend === "s3" && !isWorkerRuntime() && (!roleArn || !bucket)) {
      throw new WorkflowLaunchError(
        "terminal",
        "Workflow launch misconfigured: missing workflow storage role or bucket.",
        { status: 500, code: "workflow_storage_config_missing" },
      );
    }

    let daytonaAuth: ReturnType<typeof resolveServerDaytonaAuthParams>;
    try {
      daytonaAuth = resolveServerDaytonaAuthParams();
    } catch (error) {
      throw new WorkflowLaunchError(
        "terminal",
        "Workflow launch misconfigured: invalid Daytona server auth params.",
        { status: 500, code: "daytona_auth_invalid", cause: error },
      );
    }

    const tokenSession = await createApiTokenSession({
      subjectType: "sandbox",
      userId: envelope.workflowOwnerUserId,
      workspaceId: envelope.workspaceId,
      organizationId: envelope.workflowOwnerOrganizationId,
      runId: envelope.runId,
      accessTokenTtlSeconds: 4 * 3600,
      scopes: [
        "auth:token:refresh",
        "auth:token:revoke",
        "workflow:invoke:write",
        "workflow:invoke:read",
        "workflow:runs:read",
        "workflow:logs:read",
        "workflow:runs:events:write",
      ],
    });
    tokenSessionId = tokenSession.sessionId;

    const s3Credentials = storageBackend === "r2"
      ? buildCloudApiWorkflowStorageCredentials({
        userId: envelope.workflowOwnerUserId,
        runId: envelope.runId,
        apiUrl,
        accessToken: tokenSession.accessToken,
        refreshToken: tokenSession.refreshToken,
      })
      : await mintScopedS3Credentials({
        userId: envelope.workflowOwnerUserId,
        runId: envelope.runId,
        roleArn,
        bucket,
      });

    const resolvedRelayWorkspace = await resolveOrProvisionRelayWorkspace({
      userId: envelope.workflowOwnerUserId,
      appWorkspaceId: envelope.workspaceId,
    });
    const relayWorkspaceId = resolvedRelayWorkspace.id;
    const relayApiKey = resolvedRelayWorkspace.relaycastApiKey;
    if (resolvedRelayWorkspace.provisioned) {
      console.log(
        `[workflow-launch] Auto-provisioned relay workspace ${relayWorkspaceId} for user ${envelope.workflowOwnerUserId}`,
      );
    }
    await ensureRelayWorkspace(relayWorkspaceId, { ignored: [], readonly: [] });

    const envSecrets = await maybeInjectWorkflowGithubWriteToken(envelope);
    const credentialBundle = buildCredentialBundle({
      s3Credentials,
      cliCredentials,
      workspaceId: relayWorkspaceId,
      relayApiKey,
      relayBaseUrl: resolveRelaycastUrl(),
      runId: envelope.runId,
      userId: envelope.workflowOwnerUserId,
      cloudApiUrl: apiUrl,
      cloudApiAccessToken: tokenSession.accessToken,
      cloudApiRefreshToken: tokenSession.refreshToken,
      cloudApiAccessTokenExpiresAt: tokenSession.accessTokenExpiresAt,
      credentialProxyUrl: Object.keys(credentialProxyTokens).length > 0
        ? credentialProxyUrl
        : undefined,
      credentialProxyTokens: Object.keys(credentialProxyTokens).length > 0
        ? credentialProxyTokens
        : undefined,
      ...daytonaAuth,
      s3CodeKey: envelope.s3CodeKey,
      workflowConfig: envelope.workflow,
    });

    const credentialProxy = resolveCredentialProxyConfig();
    const isScriptWorkflow = envelope.fileType === "ts" || envelope.fileType === "py";
    const workflowFileName = isScriptWorkflow
      ? `workflow.${envelope.fileType === "ts" ? "ts" : "py"}`
      : undefined;
    const brokerPort = envelope.normalizedFileType === "yaml" && deriveInteractive(envelope.workflow)
      ? 9800
      : null;
    const launchResult = await launchOrchestratorSandbox({
      credentialBundle,
      callbackUrl,
      callbackToken: envelope.callbackToken,
      runId: envelope.runId,
      ...credentialProxy,
      relayfileUrl,
      relayAuthUrl,
      relayAuthApiKey,
      s3CodeKey: envelope.s3CodeKey,
      paths: envelope.paths,
      workflowPath: envelope.workflowPath,
      fileType: envelope.normalizedFileType,
      workflowConfig: isScriptWorkflow ? undefined : envelope.workflow,
      agentClis: isScriptWorkflow ? extractAgentClisFromScript(envelope.rawWorkflow) : undefined,
      workflowFileContent: isScriptWorkflow ? envelope.rawWorkflow : undefined,
      workflowFileName,
      envSecrets,
      metadata: envelope.metadata,
      resumeRunId: envelope.resumeRunId,
      startFrom: envelope.startFrom,
      previousRunId: envelope.previousRunId,
      brokerSecret: getBrokerKeySecret(),
      executionMode: envelope.runtime.executionMode,
      runtimeConfig: envelope.runtime.config,
      runInputs: envelope.runInputs,
      observerUrl,
      orchestratorLibUrl,
      provisioningSandboxId: input.provisioningSandboxId?.trim() || undefined,
      onProvisioningSandboxCreated: async (sandboxId) => {
        sandboxIdForFailure = sandboxId;
        persistedProvisioningSandboxId = sandboxId;
        await input.onSandboxCreated?.(sandboxId);
      },
      onSandboxCreated: async (sandboxId) => {
        sandboxIdForFailure = sandboxId;
        if (persistedProvisioningSandboxId !== sandboxId) {
          persistedProvisioningSandboxId = sandboxId;
          await input.onSandboxCreated?.(sandboxId);
        }
        await attachSandboxToApiTokenSession(tokenSession.sessionId, sandboxId);
        const now = new Date();
        await getDb().insert(sandboxes).values({
          id: sandboxId,
          userId: envelope.workflowOwnerUserId,
          organizationId: envelope.workflowOwnerOrganizationId,
          workspaceId: envelope.workspaceId,
          source: "workflow",
          runId: envelope.runId,
          status: "running",
          brokerPort,
          createdAt: now,
          updatedAt: now,
        });
        sandboxRegistered = true;
      },
    });

    const sandboxId = launchResult.sandboxId;
    const launchedExecutionMode = launchResult.executionMode ?? envelope.runtime.executionMode;
    const launchedObserverUrl = launchResult.observerUrl ?? observerUrl;
    const launchedWorkdir = launchResult.workdir ?? "/project";

    if (!sandboxRegistered) {
      await attachSandboxToApiTokenSession(tokenSession.sessionId, sandboxId);
      const now = new Date();
      await getDb().insert(sandboxes).values({
        id: sandboxId,
        userId: envelope.workflowOwnerUserId,
        organizationId: envelope.workflowOwnerOrganizationId,
        workspaceId: envelope.workspaceId,
        source: "workflow",
        runId: envelope.runId,
        status: "running",
        brokerPort,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (launchedExecutionMode === "shared-sandbox") {
      try {
        const { createDbEventClient } = await import("@cloud/core/session/events.js");
        const schema = await import("../db/schema");
        const eventClient = createDbEventClient({ db: getDb(), schema });
        await eventClient.emit({
          runId: envelope.runId,
          eventType: "sandbox_created",
          sandboxId,
          payload: {
            runId: envelope.runId,
            executionMode: "shared-sandbox",
            type: "sandbox.created",
            createdAt: new Date().toISOString(),
            sandboxId,
            workdir: launchedWorkdir,
            observerUrl: launchedObserverUrl,
          },
        });
      } catch (eventErr) {
        console.warn(
          "[workflow-launch] failed to persist shared-sandbox metadata event (non-fatal):",
          eventErr instanceof Error ? eventErr.message : String(eventErr),
        );
      }
    }

    return {
      sandboxId,
      launchedExecutionMode,
      launchedObserverUrl,
      launchedWorkdir,
      relayWorkspaceId,
    };
  } catch (error) {
    if (sandboxRegistered && sandboxIdForFailure) {
      try {
        await getDb()
          .update(sandboxes)
          .set({
            status: "archived",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(sandboxes.id, sandboxIdForFailure));
      } catch {
        // best-effort status update
      }
    }
    if (tokenSessionId) {
      try {
        await revokeApiTokenSessionById(tokenSessionId, "launch_failed");
      } catch {
        // best-effort
      }
    }
    if (error instanceof WorkflowSandboxProvisioningPendingError) {
      throw error;
    }
    if (error instanceof WorkflowLaunchError) {
      throw error;
    }
    throw new WorkflowLaunchError(
      "retryable",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
