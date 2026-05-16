import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const DEFAULT_CLOUD_BASE_URL = 'https://app.agentworkforce.com';
const DEFAULT_CONFIG_SUBDIR = path.join('.config', 'agent-relay');

const jsonResult = z.object({}).passthrough();
const providerHintSchema = z.enum(['auto', 'daytona', 'local-docker']);
const cliSchema = z.enum(['claude', 'codex', 'gemini']);

type CloudErrorCode =
  | 'NEEDS_CLOUD_LOGIN'
  | 'NEEDS_CLI_CONNECTION'
  | 'NEEDS_RELAYFILE_SETUP'
  | 'WORKSPACE_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'CLOUD_TOKEN_EXPIRED'
  | 'CLOUD_REQUEST_FAILED';

type CloudToolError = {
  code: CloudErrorCode;
  message: string;
  remediation: string;
};

type CloudWorkspace = {
  id?: string;
  workspaceId?: string;
  name?: string;
  label?: string;
};

type CloudConfig = {
  cloudToken: string;
  userId?: string;
  workspaces: CloudWorkspace[];
};

type ConnectionConfig = {
  connections: Record<string, unknown>;
};

type PreflightOptions = {
  cli?: string;
  workspaceId?: string;
};

type PreflightContext = {
  cloud: CloudConfig;
  connections: ConnectionConfig;
  workspaceId?: string;
};

type RegisterCloudToolsOptions = {
  cloudBaseUrl?: string;
  cwd?: string;
};

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? process.env.CLOUD_BASE_URL ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
}

function configDir(): string {
  const override = process.env.AGENT_RELAY_CONFIG_DIR?.trim();
  if (override) return override;
  return path.join(homedir(), DEFAULT_CONFIG_SUBDIR);
}

function configPath(filename: string): string {
  return path.join(configDir(), filename);
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function cloudToolError(error: CloudToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${error.message}\nRemediation: ${error.remediation}` }],
    structuredContent: error,
  };
}

function cloudLoginError(): CallToolResult {
  return cloudToolError({
    code: 'NEEDS_CLOUD_LOGIN',
    message: `No cloud login was found at ${configPath('cloud.json')}.`,
    remediation: 'agent-relay cloud login',
  });
}

function cliConnectionError(cli: string): CallToolResult {
  return cloudToolError({
    code: 'NEEDS_CLI_CONNECTION',
    message: `CLI "${cli}" is not connected in ${configPath('connections.json')}.`,
    remediation: `agent-relay connect ${cli}`,
  });
}

function workspaceRequiredError(workspaces: CloudWorkspace[]): CallToolResult {
  const labels = workspaces
    .map((workspace) => workspace.id ?? workspace.workspaceId ?? workspace.name ?? workspace.label)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return cloudToolError({
    code: 'WORKSPACE_REQUIRED',
    message: labels.length > 0
      ? `Multiple cloud workspaces are linked: ${labels.join(', ')}.`
      : 'Multiple cloud workspaces are linked.',
    remediation: 'Pass workspace_id to the cloud tool call.',
  });
}

function parseCloudConfig(value: unknown): CloudConfig | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const token = record.cloudToken ?? record.cloud_token ?? record.token;
  if (typeof token !== 'string' || token.trim().length === 0) return null;
  const rawWorkspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  const workspaces = rawWorkspaces
    .filter((workspace): workspace is Record<string, unknown> => !!workspace && typeof workspace === 'object')
    .map((workspace) => ({
      id: typeof workspace.id === 'string' ? workspace.id : undefined,
      workspaceId: typeof workspace.workspaceId === 'string'
        ? workspace.workspaceId
        : typeof workspace.workspace_id === 'string'
          ? workspace.workspace_id
          : undefined,
      name: typeof workspace.name === 'string' ? workspace.name : undefined,
      label: typeof workspace.label === 'string' ? workspace.label : undefined,
    }));

  return {
    cloudToken: token,
    userId: typeof record.userId === 'string'
      ? record.userId
      : typeof record.user_id === 'string'
        ? record.user_id
        : undefined,
    workspaces,
  };
}

function parseConnections(value: unknown): ConnectionConfig {
  if (!value || typeof value !== 'object') return { connections: {} };
  const record = value as Record<string, unknown>;
  const nested = record.connections;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { connections: nested as Record<string, unknown> };
  }
  return { connections: record };
}

function isConnected(connections: ConnectionConfig, cli: string): boolean {
  const entry = connections.connections[cli];
  if (!entry) return false;
  if (typeof entry === 'object' && entry !== null && 'enabled' in entry) {
    return entry.enabled !== false;
  }
  return true;
}

function resolveWorkspaceId(cloud: CloudConfig, requested?: string): string | undefined | CallToolResult {
  if (requested?.trim()) return requested.trim();
  if (cloud.workspaces.length === 0) return undefined;
  if (cloud.workspaces.length > 1) return workspaceRequiredError(cloud.workspaces);
  return cloud.workspaces[0].id ?? cloud.workspaces[0].workspaceId;
}

async function loadPreflight(options: PreflightOptions = {}): Promise<PreflightContext | CallToolResult> {
  const cloud = parseCloudConfig(await readJsonFile(configPath('cloud.json')));
  if (!cloud) return cloudLoginError();

  const connections = parseConnections(await readJsonFile(configPath('connections.json')));
  if (options.cli && !isConnected(connections, options.cli)) {
    return cliConnectionError(options.cli);
  }

  const workspaceId = resolveWorkspaceId(cloud, options.workspaceId);
  if (workspaceId && typeof workspaceId === 'object') return workspaceId;

  return { cloud, connections, workspaceId };
}

function isToolError(value: PreflightContext | CallToolResult): value is CallToolResult {
  return 'isError' in value && value.isError === true;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function extractCloudError(response: Response, body: unknown): CloudToolError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : record;
  const code = typeof nested.code === 'string' ? nested.code : undefined;

  if (!isKnownErrorCode(code) && (response.status === 401 || response.status === 403)) {
    return {
      code: 'CLOUD_TOKEN_EXPIRED',
      message: 'The cached cloud token was rejected by Cloud.',
      remediation: 'agent-relay cloud login',
    };
  }

  const message = typeof nested.message === 'string'
    ? nested.message
    : `Cloud request failed with HTTP ${response.status}.`;
  const remediation = typeof nested.remediation === 'string'
    ? nested.remediation
    : code === 'NEEDS_RELAYFILE_SETUP'
      ? 'relayfile setup --local-dir <repo>'
      : code === 'QUOTA_EXCEEDED'
        ? 'Wait for one cloud agent to finish or run cloud.agent.kill.'
        : 'Retry after checking Cloud status.';

  return {
    code: isKnownErrorCode(code) ? code : 'CLOUD_REQUEST_FAILED',
    message,
    remediation,
  };
}

function isKnownErrorCode(code: string | undefined): code is CloudErrorCode {
  return code === 'NEEDS_CLOUD_LOGIN'
    || code === 'NEEDS_CLI_CONNECTION'
    || code === 'NEEDS_RELAYFILE_SETUP'
    || code === 'WORKSPACE_REQUIRED'
    || code === 'QUOTA_EXCEEDED'
    || code === 'CLOUD_TOKEN_EXPIRED'
    || code === 'CLOUD_REQUEST_FAILED';
}

async function cloudRequest(
  baseUrl: string,
  token: string,
  pathName: string,
  init: RequestInit = {},
): Promise<CallToolResult> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    return cloudToolError(extractCloudError(response, body));
  }

  const payload = body && typeof body === 'object' && 'ok' in body
    ? (body as { ok: boolean; data?: unknown; error?: unknown })
    : null;
  if (payload && payload.ok === false) {
    return cloudToolError(extractCloudError(response, body));
  }

  const result = payload?.data ?? body;
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result && typeof result === 'object'
      ? result as Record<string, unknown>
      : { result },
  };
}

function withSearchParams(pathName: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${pathName}?${query}` : pathName;
}

export function registerCloudTools(
  server: McpServer,
  options: RegisterCloudToolsOptions = {},
): void {
  const baseUrl = normalizeBaseUrl(options.cloudBaseUrl);
  const cwd = options.cwd ?? process.cwd();

  server.registerTool('cloud.status', {
    title: 'Cloud Status',
    description: 'Inspect local Agent Relay Cloud login and CLI connection prerequisites without creating or modifying cloud resources.',
    inputSchema: {},
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const cloud = parseCloudConfig(await readJsonFile(configPath('cloud.json')));
    const connections = parseConnections(await readJsonFile(configPath('connections.json')));
    const status = {
      cloud_base_url: baseUrl,
      config_dir: configDir(),
      logged_in: !!cloud,
      user_id: cloud?.userId ?? null,
      workspaces: cloud?.workspaces ?? [],
      connected_clis: Object.keys(connections.connections).filter((cli) => isConnected(connections, cli)),
      default_relayfile_path: cwd,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      structuredContent: status,
    };
  });

  server.registerTool('cloud.agent.spawn', {
    title: 'Spawn Cloud Agent',
    description: 'Spawn a cloud-hosted agent for the selected Cloud workspace. The agent runs the connected CLI with the provided prompt and joins the requested Relaycast channel.',
    inputSchema: {
      cli: cliSchema.describe('Connected local CLI profile to run in the sandbox'),
      prompt: z.string().min(1).describe('Initial task prompt for the spawned cloud agent'),
      workspace_id: z.string().optional().describe('Cloud workspace ID. Required when the login has more than one workspace.'),
      agent_name: z.string().optional().describe('Optional requested Relaycast agent name'),
      relayfile_paths: z.array(z.string()).optional().describe('Local paths to mount via Relayfile. Defaults to the MCP process current working directory.'),
      relaycast_channel: z.string().optional().describe('Relaycast channel for the spawned agent to join or create'),
      ttl_seconds: z.number().int().positive().max(21600).optional().describe('Maximum sandbox lifetime in seconds'),
      provider_hint: providerHintSchema.optional().describe('Optional sandbox provider override'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ cli, prompt, workspace_id, agent_name, relayfile_paths, relaycast_channel, ttl_seconds, provider_hint }) => {
    const preflight = await loadPreflight({ cli, workspaceId: workspace_id });
    if (isToolError(preflight)) return preflight;
    const body = {
      workspaceId: preflight.workspaceId,
      cli,
      prompt,
      ...(agent_name ? { agentName: agent_name } : {}),
      relayfilePaths: relayfile_paths?.length ? relayfile_paths : [cwd],
      ...(relaycast_channel ? { relaycastChannel: relaycast_channel } : {}),
      ...(ttl_seconds ? { ttlSeconds: ttl_seconds } : {}),
      ...(provider_hint ? { providerHint: provider_hint } : {}),
    };
    return await cloudRequest(baseUrl, preflight.cloud.cloudToken, '/api/v1/agents/spawn', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  server.registerTool('cloud.agent.list', {
    title: 'List Cloud Agents',
    description: 'List cloud agents visible to the logged-in Cloud account, optionally scoped to a workspace.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Cloud workspace ID to filter agents by'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ workspace_id }) => {
    const preflight = await loadPreflight({ workspaceId: workspace_id });
    if (isToolError(preflight)) return preflight;
    return await cloudRequest(
      baseUrl,
      preflight.cloud.cloudToken,
      withSearchParams('/api/v1/agents', { workspaceId: preflight.workspaceId }),
    );
  });

  server.registerTool('cloud.agent.kill', {
    title: 'Kill Cloud Agent',
    description: 'Terminate a running cloud agent sandbox by agent ID.',
    inputSchema: {
      agent_id: z.string().describe('Cloud agent ID to terminate'),
      workspace_id: z.string().optional().describe('Cloud workspace ID, required when the login has more than one workspace'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ agent_id, workspace_id }) => {
    const preflight = await loadPreflight({ workspaceId: workspace_id });
    if (isToolError(preflight)) return preflight;
    return await cloudRequest(
      baseUrl,
      preflight.cloud.cloudToken,
      withSearchParams(`/api/v1/agents/${encodeURIComponent(agent_id)}`, { workspaceId: preflight.workspaceId }),
      { method: 'DELETE' },
    );
  });

  server.registerTool('cloud.slack.bridge', {
    title: 'Create Slack Relay Bridge',
    description: 'Create or return a Slack-to-Relaycast bridge for a Cloud workspace, Slack channel, and Relaycast channel.',
    inputSchema: {
      slack_channel_id: z.string().describe('Slack channel ID to bridge'),
      relay_channel_id: z.string().describe('Relaycast channel ID or name to bridge'),
      workspace_id: z.string().optional().describe('Cloud workspace ID, required when the login has more than one workspace'),
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ slack_channel_id, relay_channel_id, workspace_id }) => {
    const preflight = await loadPreflight({ workspaceId: workspace_id });
    if (isToolError(preflight)) return preflight;
    return await cloudRequest(baseUrl, preflight.cloud.cloudToken, '/api/v1/slack/relay-bridge', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: preflight.workspaceId,
        slackChannelId: slack_channel_id,
        relayChannelId: relay_channel_id,
      }),
    });
  });
}
