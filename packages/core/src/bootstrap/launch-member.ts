import type { CredentialBundle } from "../auth/credentials.js";
import {
  mintWorkspacePathScopedRelayfileToken as defaultMintWorkspacePathScopedRelayfileToken,
} from "../relayfile/client.js";
import {
  assertPairwiseDisjointScopes,
  assertSafeMemberWritePath,
  memberWritePath,
  pathScope,
  validateMemberRelayfileAccessScopes,
  validateMemberWriteScopes,
} from "../proactive-runtime/member-token-scope.js";
import {
  launchOrchestratorSandbox as defaultLaunchOrchestratorSandbox,
  type LaunchOptions,
  type LaunchResult,
} from "./launcher.js";

const MEMBER_TOKEN_TTL_SECONDS = 120;

export interface LaunchMemberOptions {
  memberName: string;
  role: string;
  channel: string;
  assignedRoot: string;
  localRoot: string;
  workspaceId: string;
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey?: string;
  relayfileToken?: string;
  runId: string;
  harness?: string;
  model?: string;
  credentialBundle: CredentialBundle;
  fileType: LaunchOptions["fileType"];
  workflowConfig?: string;
  workflowPath?: string;
  workflowFileContent?: string;
  workflowFileName?: string;
  s3CodeKey?: string;
  snapshot?: string;
  envSecrets?: Record<string, string>;
  orchestratorLibTarball?: Uint8Array;
  orchestratorLibUrl?: string;
  onSandboxCreated?: LaunchOptions["onSandboxCreated"];
  provisioningSandboxId?: string;
  onProvisioningSandboxCreated?: LaunchOptions["onProvisioningSandboxCreated"];
}

export interface LaunchMemberResult {
  memberName: string;
  role: string;
  channel: string;
  sandboxId: string;
  assignedRoot: string;
  localRoot: string;
  relayfileToken: string;
  writeScopes: string[];
}

export interface JoinRelaycastChannelInput {
  channel: string;
  memberName: string;
  role: string;
}

export interface LaunchMemberDeps {
  mintWorkspacePathScopedRelayfileToken?: typeof defaultMintWorkspacePathScopedRelayfileToken;
  launchOrchestratorSandbox?: typeof defaultLaunchOrchestratorSandbox;
  joinRelaycastChannel?: (input: JoinRelaycastChannelInput) => Promise<void> | void;
}

export async function launchMember(
  options: LaunchMemberOptions,
  deps: LaunchMemberDeps = {},
): Promise<LaunchMemberResult> {
  const assignedRoots = [assertSafeMemberWritePath(options.assignedRoot)];
  assertPairwiseDisjointScopes([
    {
      memberName: options.memberName,
      assignedPaths: assignedRoots,
    },
  ]);

  const expectedWriteScopes = validateMemberWriteScopes(
    assignedRoots.map((root) => pathScope(root)),
    assignedRoots,
  );

  const mintWorkspacePathScopedRelayfileToken =
    deps.mintWorkspacePathScopedRelayfileToken ?? defaultMintWorkspacePathScopedRelayfileToken;
  const launchOrchestratorSandbox =
    deps.launchOrchestratorSandbox ?? defaultLaunchOrchestratorSandbox;

  let relayfileToken = options.relayfileToken?.trim();
  if (relayfileToken) {
    if (relayfileToken.startsWith("relay_ws_")) {
      throw new Error("launchMember direct member token must not be a relay_ws_ workspace token");
    }
  } else {
    const relayAuthApiKey = options.relayAuthApiKey?.trim();
    if (relayAuthApiKey) {
      // Prefer the direct org-key mint: launchMember no longer depends on a
      // pre-seeded workspace token to derive the member relayfile token.
      relayfileToken = await mintWorkspacePathScopedRelayfileToken({
        workspaceId: options.workspaceId,
        relayAuthUrl: options.relayAuthUrl,
        relayAuthApiKey,
        agentName: options.memberName,
        paths: assignedRoots.map((root) => memberWritePath(root)),
        scopes: expectedWriteScopes,
        ttlSeconds: MEMBER_TOKEN_TTL_SECONDS,
      });
    } else {
      throw new Error("launchMember requires either a direct relay_pa_ token or a relayAuthApiKey");
    }
  }

  const decodedScopes = scopesFromRelayfileAccessToken(relayfileToken);
  const writeScopes = validateMemberRelayfileAccessScopes(decodedScopes, assignedRoots);

  await deps.joinRelaycastChannel?.({
    channel: options.channel,
    memberName: options.memberName,
    role: options.role,
  });

  // Member boxes use the narrow-mount model: only the assigned Relayfile root is
  // mounted, while localRoot selects the sandbox workdir/code mount path.
  const launchResult = await launchOrchestratorSandbox({
    credentialBundle: options.credentialBundle,
    runId: options.runId,
    ...(options.harness ? { memberHarness: options.harness } : {}),
    ...(options.model ? { memberModel: options.model } : {}),
    fileType: options.fileType,
    workspaceId: options.workspaceId,
    relayfileUrl: options.relayfileUrl,
    relayAuthUrl: options.relayAuthUrl,
    ...(options.s3CodeKey ? { s3CodeKey: options.s3CodeKey } : {}),
    ...(options.workflowConfig ? { workflowConfig: options.workflowConfig } : {}),
    ...(options.workflowPath ? { workflowPath: options.workflowPath } : {}),
    ...(options.workflowFileContent ? { workflowFileContent: options.workflowFileContent } : {}),
    ...(options.workflowFileName ? { workflowFileName: options.workflowFileName } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    ...(options.envSecrets ? { envSecrets: options.envSecrets } : {}),
    ...(options.orchestratorLibTarball ? { orchestratorLibTarball: options.orchestratorLibTarball } : {}),
    ...(options.orchestratorLibUrl ? { orchestratorLibUrl: options.orchestratorLibUrl } : {}),
    ...(options.onSandboxCreated ? { onSandboxCreated: options.onSandboxCreated } : {}),
    ...(options.provisioningSandboxId ? { provisioningSandboxId: options.provisioningSandboxId } : {}),
    ...(options.onProvisioningSandboxCreated
      ? { onProvisioningSandboxCreated: options.onProvisioningSandboxCreated }
      : {}),
    codeMountPath: options.localRoot,
    relayfileMountPaths: assignedRoots,
    relayfileMemberAccess: {
      agentName: options.memberName,
      token: relayfileToken,
      scopes: decodedScopes,
    },
    metadata: {
      LAUNCH_MEMBER_NAME: options.memberName,
      LAUNCH_MEMBER_ROLE: options.role,
      LAUNCH_MEMBER_CHANNEL: options.channel,
      LAUNCH_MEMBER_ASSIGNED_ROOT: options.assignedRoot,
      LAUNCH_MEMBER_LOCAL_ROOT: options.localRoot,
      ...(options.harness ? { LAUNCH_MEMBER_HARNESS: options.harness } : {}),
      ...(options.model ? { LAUNCH_MEMBER_MODEL: options.model } : {}),
    },
  });

  return {
    memberName: options.memberName,
    role: options.role,
    channel: options.channel,
    sandboxId: launchResult.sandboxId,
    assignedRoot: options.assignedRoot,
    localRoot: options.localRoot,
    relayfileToken,
    writeScopes,
  };
}

export function scopesFromRelayfileAccessToken(accessToken: string): string[] {
  if (!accessToken.startsWith("relay_pa_")) {
    throw new Error("relayfile member access token must use the relay_pa_ prefix");
  }

  const token = accessToken.slice("relay_pa_".length);
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("relay_pa_ token is not a JWT");
  }

  let payload: unknown;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    payload = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new Error(`relay_pa_ token payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(payload)) {
    throw new Error("relay_pa_ token payload must be an object");
  }

  const scopes = payload.scopes;
  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === "string");
  }

  const scope = payload.scope;
  if (typeof scope === "string") {
    return scope.split(/\s+/u).map((entry) => entry.trim()).filter(Boolean);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
