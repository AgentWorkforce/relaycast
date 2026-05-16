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

// Single canonical config shape — AGENTS.md prohibits mixed-case field
// fallbacks (e.g. `cloud_token`, `workspace_id`, `user_id`), and the zod
// schemas below enforce that boundary instead of the previous ad-hoc
// typeof/`??` chain.
const cloudWorkspaceSchema = z.object({
  id: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
});

const cloudConfigSchema = z.object({
  cloudToken: z.string().min(1),
  userId: z.string().optional(),
  workspaces: z.array(cloudWorkspaceSchema).default([]),
});

// connections.json may be written either as `{ connections: { … } }` or as a
// flat record of CLI → entry. Both shapes are documented in the existing
// fixtures; this is a single-canonical-shape on disk choice, not a mixed-case
// fallback. The schema accepts either and normalizes to `{ connections }`.
const connectionsRecordSchema = z.record(z.string(), z.unknown());
const connectionsConfigSchema = z
  .object({
    connections: connectionsRecordSchema.optional(),
  })
  .passthrough()
  .transform((value): { connections: Record<string, unknown> } => {
    if (value.connections && typeof value.connections === 'object') {
      return { connections: value.connections as Record<string, unknown> };
    }
    const { connections: _drop, ...rest } = value as Record<string, unknown> & {
      connections?: unknown;
    };
    return { connections: rest as Record<string, unknown> };
  });

type CloudWorkspace = z.infer<typeof cloudWorkspaceSchema>;
type CloudConfig = z.infer<typeof cloudConfigSchema>;
type ConnectionConfig = z.infer<typeof connectionsConfigSchema>;

type PreflightOptions = {
  cli?: string;
  workspaceId?: string;
  /**
   * When false, callers explicitly opt out of workspace resolution — the
   * preflight will not return WORKSPACE_REQUIRED for multi-workspace logins
   * unless a workspaceId was supplied. Defaults to true to keep existing
   * tools (spawn / kill / slack.bridge) working.
   */
  requireWorkspace?: boolean;
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

type JsonReadResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: Error };

async function readJsonFile(filePath: string): Promise<JsonReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }
  try {
    return { kind: 'ok', value: JSON.parse(raw) as unknown };
  } catch (error) {
    // Malformed JSON gets surfaced as a structured tool error by callers
    // rather than escaping as an uncaught SyntaxError.
    return { kind: 'malformed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function malformedConfigError(filePath: string, error: Error): CallToolResult {
  return cloudToolError({
    code: 'CLOUD_REQUEST_FAILED',
    message: `Failed to parse ${filePath}: ${error.message}`,
    remediation: `Fix the JSON in ${filePath} or re-run agent-relay cloud login to regenerate it.`,
  });
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
  const parsed = cloudConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseConnections(value: unknown): ConnectionConfig {
  const parsed = connectionsConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : { connections: {} };
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
  const cloudJsonPath = configPath('cloud.json');
  const cloudRead = await readJsonFile(cloudJsonPath);
  if (cloudRead.kind === 'malformed') {
    return malformedConfigError(cloudJsonPath, cloudRead.error);
  }
  const cloud = cloudRead.kind === 'ok' ? parseCloudConfig(cloudRead.value) : null;
  if (!cloud) return cloudLoginError();

  const connectionsJsonPath = configPath('connections.json');
  const connectionsRead = await readJsonFile(connectionsJsonPath);
  if (connectionsRead.kind === 'malformed') {
    return malformedConfigError(connectionsJsonPath, connectionsRead.error);
  }
  const connections = connectionsRead.kind === 'ok'
    ? parseConnections(connectionsRead.value)
    : { connections: {} };
  if (options.cli && !isConnected(connections, options.cli)) {
    return cliConnectionError(options.cli);
  }

  // Only resolve a workspace when one was requested or the login is single-
  // workspace. When the caller passes `requireWorkspace: false` and omits
  // `workspaceId`, skip multi-workspace gating so account-wide listing is
  // possible (cloud.agent.list use case).
  const requireWorkspace = options.requireWorkspace ?? true;
  const workspaceId = requireWorkspace || options.workspaceId
    ? resolveWorkspaceId(cloud, options.workspaceId)
    : options.workspaceId?.trim() || undefined;
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
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathName}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    // Network errors (DNS, refused, timeout, abort) bypass the HTTP-status
    // branch below. Normalize them through cloudToolError so callers always
    // receive the structured remediation envelope.
    return cloudToolError({
      code: 'CLOUD_REQUEST_FAILED',
      message: error instanceof Error
        ? error.message
        : 'Cloud request failed before a response was received.',
      remediation: 'Retry after checking Cloud status.',
    });
  }
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
    const cloudJsonPath = configPath('cloud.json');
    const cloudRead = await readJsonFile(cloudJsonPath);
    if (cloudRead.kind === 'malformed') {
      return malformedConfigError(cloudJsonPath, cloudRead.error);
    }
    const cloud = cloudRead.kind === 'ok' ? parseCloudConfig(cloudRead.value) : null;
    const connectionsJsonPath = configPath('connections.json');
    const connectionsRead = await readJsonFile(connectionsJsonPath);
    if (connectionsRead.kind === 'malformed') {
      return malformedConfigError(connectionsJsonPath, connectionsRead.error);
    }
    const connections = connectionsRead.kind === 'ok'
      ? parseConnections(connectionsRead.value)
      : { connections: {} };
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
    // cloud.agent.list advertises workspace scoping as optional, so opt out
    // of WORKSPACE_REQUIRED gating when the caller didn't supply one. This
    // keeps "list across all workspaces" working for multi-workspace logins.
    const preflight = await loadPreflight({
      workspaceId: workspace_id,
      requireWorkspace: false,
    });
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
