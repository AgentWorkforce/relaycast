/** Server-owned workspace delivery growth contract; never request supplied. */
export interface WorkspaceDeliveryPolicy {
  /** Maximum active workspace delivery rows (queued+delivered, unexpired). */
  cap: number;
  /**
   * Optional reserve carved OUT of `cap` for server-classified targeted sends.
   * Broadcast admission requires `depth + new <= cap - reserve`; targeted
   * admission requires `depth + new <= cap`. Must satisfy `0 <= reserve < cap`.
   */
  reserve?: number;
}

export interface WorkspaceDeliveryPolicyConfig {
  cap?: number;
  reserve?: number;
  workspaces?: Record<string, { cap?: number; reserve?: number } | undefined>;
  /**
   * Server-only async resolver for dynamic, request-time plans (e.g. a
   * KV-backed effective plan lookup). When present it takes precedence over the
   * static `cap`/`workspaces` fields, so a host whose plan is async does not
   * have to flatten every workspace into static config. Never source this from
   * a client request.
   */
  resolve?: (workspace: { id: string; plan: string }) => Promise<WorkspaceDeliveryPolicy | undefined>;
}
