/** Backend-neutral message search input. workspaceId is supplied by authenticated engine context. */
export interface MessageSearchOptions {
  q: string;
  channel?: string;
  from?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export interface MessageSearchQuery extends MessageSearchOptions {
  workspaceId: string;
  /** Engine-normalized result cap: defaults to 20, bounded to 1–100. */
  limit: number;
}

/** Internal result includes visibility metadata which the HTTP route filters before returning. */
export interface MessageSearchResult {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_type: number;
  conversation_id: string | null;
  agent_id: string;
  agent_name: string;
  text: string;
  created_at: string;
  /** Lower is more relevant; results are ordered best first. SQLite exposes raw
   * negative bm25 values. Magnitudes are backend-specific and cannot be compared
   * across backends; adapters must retain the lower-is-better direction. */
  relevance_score: number;
}

/**
 * Message-search seam for storage adapters. Implementations must constrain the
 * query to workspaceId in storage, preserve filters/pagination, and return the
 * visibility metadata needed by the engine's observer authorization checks.
 * Directory/routing/mention search will gain their own methods separately.
 */
export interface SearchIndex {
  searchMessages(query: MessageSearchQuery): Promise<MessageSearchResult[]>;
}
