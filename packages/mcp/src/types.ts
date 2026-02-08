import type { WsBridge } from './resources/ws-bridge.js';
import type { SubscriptionManager } from './resources/subscriptions.js';

export interface SessionState {
  agentToken: string | null;
  agentName: string | null;
  wsBridge: WsBridge | null;
  subscriptions: SubscriptionManager | null;
}

export function createInitialSession(): SessionState {
  return { agentToken: null, agentName: null, wsBridge: null, subscriptions: null };
}

