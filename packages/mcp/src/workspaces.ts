import { z } from 'zod';
import type { SessionState, WorkspaceContext } from './types.js';

/**
 * Configuration for a single workspace provided via RELAY_WORKSPACES_JSON.
 */
export interface McpWorkspaceConfig {
  workspace_id: string;
  workspace_alias?: string;
  api_key: string;
  agent_token?: string;
  agent_name?: string;
}

/**
 * Parse RELAY_WORKSPACES_JSON env var into an array of workspace configs.
 * Returns an empty array if the env var is not set or empty.
 */
export function parseWorkspaceEnv(raw?: string): McpWorkspaceConfig[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('RELAY_WORKSPACES_JSON must be a JSON array');
    }
    return validateWorkspaceConfigs(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`RELAY_WORKSPACES_JSON is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Validate an array of workspace config objects.
 * Ensures each entry has the required fields.
 */
export function validateWorkspaceConfigs(configs: unknown[]): McpWorkspaceConfig[] {
  return configs.map((cfg, i) => {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error(`RELAY_WORKSPACES_JSON[${i}] must be an object`);
    }
    const obj = cfg as Record<string, unknown>;
    if (!obj.workspace_id || typeof obj.workspace_id !== 'string') {
      throw new Error(`RELAY_WORKSPACES_JSON[${i}].workspace_id is required and must be a string`);
    }
    if (!obj.api_key || typeof obj.api_key !== 'string') {
      throw new Error(`RELAY_WORKSPACES_JSON[${i}].api_key is required and must be a string`);
    }
    return {
      workspace_id: obj.workspace_id as string,
      workspace_alias: typeof obj.workspace_alias === 'string' ? obj.workspace_alias : undefined,
      api_key: obj.api_key as string,
      agent_token: typeof obj.agent_token === 'string' ? obj.agent_token : undefined,
      agent_name: typeof obj.agent_name === 'string' ? obj.agent_name : undefined,
    };
  });
}

/**
 * Resolve which workspace ID should be the default/active workspace.
 * Falls back to the first workspace in the list.
 */
export function resolveDefaultWorkspaceId(
  configs: McpWorkspaceConfig[],
  defaultWorkspace?: string,
): string | undefined {
  if (!configs.length) return undefined;
  if (defaultWorkspace) {
    const match = configs.find(
      c => c.workspace_id === defaultWorkspace || c.workspace_alias === defaultWorkspace,
    );
    if (match) return match.workspace_id;
  }
  return configs[0].workspace_id;
}

/**
 * Optional workspace routing params added to messaging tools.
 * When provided, the tool targets a specific workspace instead of the active one.
 */
export const workspaceRoutingInputShape = {
  workspace_id: z.string().optional().describe(
    'Target a specific workspace by its workspace_id (from RELAY_WORKSPACES_JSON). If omitted, uses the active workspace.',
  ),
  workspace_alias: z.string().optional().describe(
    'Target a specific workspace by its alias (from RELAY_WORKSPACES_JSON). If omitted, uses the active workspace.',
  ),
};

/**
 * Extract workspace routing info from tool arguments.
 * Returns the workspace_id or workspace_alias if provided, or undefined.
 */
export function workspaceRefFromArgs(
  args: { workspace_id?: string; workspace_alias?: string },
): { workspace_id?: string; workspace_alias?: string } | undefined {
  if (args.workspace_id || args.workspace_alias) {
    return {
      workspace_id: args.workspace_id,
      workspace_alias: args.workspace_alias,
    };
  }
  return undefined;
}

/**
 * Find a WorkspaceContext in the session by workspace_id or workspace_alias.
 * Scans the workspaces Map for matching entries.
 */
export function findWorkspaceContext(
  session: SessionState,
  ref: { workspace_id?: string; workspace_alias?: string },
  configs: McpWorkspaceConfig[],
): WorkspaceContext | undefined {
  // Try to find the matching config first to get the api_key
  const config = configs.find(c => {
    if (ref.workspace_id && c.workspace_id === ref.workspace_id) return true;
    if (ref.workspace_alias && c.workspace_alias === ref.workspace_alias) return true;
    return false;
  });

  if (!config) return undefined;

  // Look up by api_key in session.workspaces
  return session.workspaces.get(config.api_key);
}
