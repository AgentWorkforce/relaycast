import type { WsBridge } from './resources/ws-bridge.js';
import type { SubscriptionManager } from './resources/subscriptions.js';

export interface SessionState {
  workspaceKey: string | null;
  agentToken: string | null;
  agentName: string | null;
  wsBridge: WsBridge | null;
  subscriptions: SubscriptionManager | null;
}

export function createInitialSession(workspaceKey: string | null = null): SessionState {
  return { workspaceKey, agentToken: null, agentName: null, wsBridge: null, subscriptions: null };
}
