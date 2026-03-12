import type { WsBridge } from './resources/ws-bridge.js';
import type { SubscriptionManager } from './resources/subscriptions.js';

/** Saved context for a single workspace membership. */
export interface WorkspaceContext {
  workspaceKey: string;
  agentToken: string;
  agentName: string;
  /** Canonical workspace name from the Relaycast API. */
  workspaceName?: string;
  /** Optional user-saved label for switching. */
  workspaceLabel?: string;
  wsBridge: WsBridge | null;
  subscriptions: SubscriptionManager | null;
  wsInitAttempted: boolean;
}

export interface SessionState {
  workspaceKey: string | null;
  agentToken: string | null;
  agentName: string | null;
  wsBridge: WsBridge | null;
  subscriptions: SubscriptionManager | null;
  wsInitAttempted: boolean;
  /** Map of workspace key → saved context for joined workspaces. */
  workspaces: Map<string, WorkspaceContext>;
}

export interface InitialSessionOptions {
  workspaceKey?: string | null;
  agentToken?: string | null;
  agentName?: string | null;
}

export function createInitialSession(
  workspaceKeyOrOptions: string | null | InitialSessionOptions = null,
): SessionState {
  const opts: InitialSessionOptions =
    typeof workspaceKeyOrOptions === 'object' && workspaceKeyOrOptions !== null && !Array.isArray(workspaceKeyOrOptions) && 'workspaceKey' in workspaceKeyOrOptions
      ? workspaceKeyOrOptions
      : { workspaceKey: workspaceKeyOrOptions as string | null };

  return {
    workspaceKey: opts.workspaceKey ?? null,
    agentToken: opts.agentToken ?? null,
    agentName: opts.agentName ?? null,
    wsBridge: null,
    subscriptions: null,
    wsInitAttempted: false,
    workspaces: new Map(),
  };
}
