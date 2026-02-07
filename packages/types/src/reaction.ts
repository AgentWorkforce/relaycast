export interface Reaction {
  id: string;
  message_id: string;
  agent_id: string;
  emoji: string;
  created_at: string;
}

export interface AddReactionRequest {
  emoji: string;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  agents: string[];
}
