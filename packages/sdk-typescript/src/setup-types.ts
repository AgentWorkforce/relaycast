import type { CreateAgentRequest, CreateAgentResponse } from './types.js';

export interface RelaycastSetupOptions {
  /**
   * Base URL for the Relaycast API.
   * @default "https://api.relaycast.dev"
   */
  baseUrl?: string;

  /**
   * Workspace API key (rk_live_... or rk_test_...).
   * When omitted, workspace creation proceeds anonymously and returns
   * a new API key. Anonymous workspaces are publicly joinable.
   */
  apiKey?: string | (() => string | Promise<string>);

  /**
   * Timeout in milliseconds for each HTTP request to the API.
   * @default 30_000
   */
  requestTimeoutMs?: number;

  /**
   * Retry configuration for API calls.
   * @default { maxRetries: 3, baseDelayMs: 500 }
   */
  retry?: {
    maxRetries: number;
    baseDelayMs: number;
  };

  /**
   * Enable local mode, targeting a locally running Relaycast daemon.
   * Automatically sets baseUrl to http://127.0.0.1:7528 if not overridden.
   * @default false
   */
  local?: boolean;
}

export interface CreateWorkspaceOptions {
  /**
   * Human-readable name for the workspace.
   */
  name: string;
}

export type JoinWorkspaceOptions = Record<string, never>;

export interface WorkspaceInfo {
  workspaceId: string;
  apiKey: string;
  baseUrl: string;
  /** ISO 8601 creation timestamp */
  createdAt?: string;
  name?: string;
}

export type RegisterAgentOptions = CreateAgentRequest;

export interface AgentRecord extends Omit<CreateAgentResponse, 'status'> {
  type: NonNullable<CreateAgentRequest['type']>;
  status: CreateAgentResponse['status'];
}
