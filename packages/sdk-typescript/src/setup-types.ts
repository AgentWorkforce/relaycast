import type { CreateAgentRequest, CreateAgentResponse } from './types.js';
import type { WorkspaceProvenanceOptions } from './workspace-provenance.js';

export interface RelaycastSetupOptions {
  /**
   * Base URL for the Relaycast API.
   * @default "https://cast.agentrelay.com"
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
}

export interface CreateWorkspaceOptions {
  /**
   * Human-readable name for the workspace.
   */
  name: string;
  /**
   * Explicitly expire this throwaway workspace after 60 seconds to 30 days.
   * Omit for a persistent workspace.
   */
  expiresInSeconds?: number;
  /** Creation context recorded once for hosted usage attribution. */
  provenance?: WorkspaceProvenanceOptions;
}

export type JoinWorkspaceOptions = Record<string, never>;

export interface WorkspaceInfo {
  workspaceId: string;
  apiKey: string;
  baseUrl: string;
  /** ISO 8601 creation timestamp */
  createdAt?: string;
  /** ISO 8601 expiry timestamp for an explicitly ephemeral workspace. */
  expiresAt?: string | null;
  name?: string;
}

export type RegisterAgentOptions = CreateAgentRequest;

export interface AgentRecord extends Omit<CreateAgentResponse, 'status'> {
  type: NonNullable<CreateAgentRequest['type']>;
  status: CreateAgentResponse['status'];
}
