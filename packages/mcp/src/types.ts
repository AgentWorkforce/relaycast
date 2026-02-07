export interface SessionState {
  agentToken: string | null;
  agentName: string | null;
}

export function createInitialSession(): SessionState {
  return { agentToken: null, agentName: null };
}

