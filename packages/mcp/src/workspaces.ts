import {
  MultiWorkspaceSessionManager,
  type WorkspaceMembershipConfig,
  type WorkspaceRef,
} from '@relaycast/sdk';
import { z } from 'zod';

export interface McpWorkspaceConfig {
  workspaceId: string;
  workspaceAlias?: string;
  workspaceKey?: string;
  agentToken?: string;
  agentName?: string;
  agentId?: string;
  agentType?: 'agent' | 'human';
}

const configuredWorkspaceSchema = z.object({
  workspace_id: z.string().trim().min(1),
  workspace_alias: z.string().trim().min(1).optional(),
  api_key: z.string().trim().min(1).optional(),
  agent_token: z.string().trim().min(1).optional(),
  agent_name: z.string().trim().min(1).optional(),
  agent_id: z.string().trim().min(1).optional(),
  agent_type: z.enum(['agent', 'human']).optional(),
});

const configuredWorkspacePayloadSchema = z.object({
  memberships: z.array(configuredWorkspaceSchema),
  default_workspace_id: z.string().trim().min(1).optional(),
});

export const workspaceRoutingInputShape = {
  workspace_id: z.string().optional().describe('Optional workspace ID to route this call to explicitly'),
  workspace_alias: z.string().optional().describe('Optional workspace alias to route this call to explicitly'),
};

export function parseWorkspaceEnv(value: string | undefined): McpWorkspaceConfig[] | undefined {
  if (!value) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `RELAY_WORKSPACES_JSON must be valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const rawMemberships = Array.isArray(parsed)
    ? parsed
    : configuredWorkspacePayloadSchema.safeParse(parsed).success
      ? configuredWorkspacePayloadSchema.parse(parsed).memberships
      : null;

  if (!rawMemberships) {
    throw new Error(
      'RELAY_WORKSPACES_JSON must decode to either an array of workspace objects or an object containing memberships.',
    );
  }

  return validateWorkspaceConfigs(rawMemberships.map((item) => {
    const workspace = configuredWorkspaceSchema.parse(item);
    return {
      workspaceId: workspace.workspace_id,
      ...(workspace.workspace_alias ? { workspaceAlias: workspace.workspace_alias } : {}),
      ...(workspace.api_key ? { workspaceKey: workspace.api_key } : {}),
      ...(workspace.agent_token ? { agentToken: workspace.agent_token } : {}),
      ...(workspace.agent_name ? { agentName: workspace.agent_name } : {}),
      ...(workspace.agent_id ? { agentId: workspace.agent_id } : {}),
      ...(workspace.agent_type ? { agentType: workspace.agent_type } : {}),
    } satisfies McpWorkspaceConfig;
  }));
}

export function validateWorkspaceConfigs(workspaces: McpWorkspaceConfig[]): McpWorkspaceConfig[] {
  const seenWorkspaceIds = new Set<string>();
  const seenAliases = new Set<string>();

  for (const workspace of workspaces) {
    const workspaceId = workspace.workspaceId.trim();
    if (workspaceId.length === 0) {
      throw new Error('Each configured workspace requires a non-empty workspaceId.');
    }
    if (seenWorkspaceIds.has(workspaceId)) {
      throw new Error(`Duplicate workspaceId "${workspaceId}" is not allowed.`);
    }
    seenWorkspaceIds.add(workspaceId);

    const workspaceAlias = workspace.workspaceAlias?.trim();
    if (!workspaceAlias) continue;
    if (seenAliases.has(workspaceAlias)) {
      throw new Error(`Duplicate workspaceAlias "${workspaceAlias}" is not allowed.`);
    }
    seenAliases.add(workspaceAlias);
  }

  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId.trim(),
    ...(workspace.workspaceAlias?.trim() ? { workspaceAlias: workspace.workspaceAlias.trim() } : {}),
    ...(workspace.workspaceKey?.trim() ? { workspaceKey: workspace.workspaceKey.trim() } : {}),
    ...(workspace.agentToken?.trim() ? { agentToken: workspace.agentToken.trim() } : {}),
    ...(workspace.agentName?.trim() ? { agentName: workspace.agentName.trim() } : {}),
    ...(workspace.agentId?.trim() ? { agentId: workspace.agentId.trim() } : {}),
    ...(workspace.agentType ? { agentType: workspace.agentType } : {}),
  }));
}

export function resolveDefaultWorkspaceId(
  workspaces: McpWorkspaceConfig[],
  defaultWorkspace: string | undefined,
): string | undefined {
  const normalizedDefault = defaultWorkspace?.trim();
  if (!normalizedDefault) {
    return workspaces.length === 1 ? workspaces[0]!.workspaceId : undefined;
  }

  const byId = workspaces.find((workspace) => workspace.workspaceId === normalizedDefault);
  if (byId) {
    return byId.workspaceId;
  }

  const byAlias = workspaces.find((workspace) => workspace.workspaceAlias === normalizedDefault);
  if (byAlias) {
    return byAlias.workspaceId;
  }

  throw new Error(
    `Default workspace "${normalizedDefault}" does not match any configured workspace_id or workspace_alias.`,
  );
}

export function buildMultiWorkspaceManager(
  workspaces: McpWorkspaceConfig[],
  defaultWorkspaceId: string | undefined,
  baseUrl?: string,
): MultiWorkspaceSessionManager | null {
  const memberships: WorkspaceMembershipConfig[] = workspaces
    .filter((workspace) => workspace.agentToken)
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      ...(workspace.workspaceAlias ? { workspaceAlias: workspace.workspaceAlias } : {}),
      ...(workspace.agentId ? { agentId: workspace.agentId } : {}),
      ...(workspace.agentName ? { agentName: workspace.agentName } : {}),
      agentToken: workspace.agentToken!,
      ...(baseUrl ? { baseUrl } : {}),
    }));

  if (memberships.length === 0) {
    return null;
  }

  const managerDefaultWorkspaceId = defaultWorkspaceId && memberships.some(
    (membership) => membership.workspaceId === defaultWorkspaceId,
  )
    ? defaultWorkspaceId
    : memberships.length === 1 && workspaces.length === 1
      ? memberships[0]!.workspaceId
      : undefined;

  return new MultiWorkspaceSessionManager({
    memberships,
    ...(managerDefaultWorkspaceId ? { defaultWorkspaceId: managerDefaultWorkspaceId } : {}),
  });
}

export function workspaceRefFromArgs(value: unknown): WorkspaceRef | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const workspaceId = typeof (value as { workspace_id?: unknown }).workspace_id === 'string'
    ? (value as { workspace_id: string }).workspace_id.trim()
    : '';
  const workspaceAlias = typeof (value as { workspace_alias?: unknown }).workspace_alias === 'string'
    ? (value as { workspace_alias: string }).workspace_alias.trim()
    : '';

  if (!workspaceId && !workspaceAlias) {
    return undefined;
  }

  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceAlias ? { workspaceAlias } : {}),
  };
}
