export type Direction = "inbound" | "writeback" | "sync";

/** Result of running one fixture through the real code path. */
export interface FixtureResult {
  direction: Direction;
  label: string;
  passed: boolean;
  errors: string[];
  /**
   * Captured evidence for G5 sign-off:
   *  - inbound/sync: { writes, deletes }
   *  - writeback: { outcome, capturedRequests, matchedRequest }
   */
  evidence: unknown;
}

/** Aggregate result for one provider manifest. */
export interface ProviderResult {
  provider: string;
  /** A capability is green when every fixture under it passed. */
  capabilities: {
    webhook: { declared: boolean; fixtures: number; passed: number };
    writeback: { declared: boolean; fixtures: number; passed: number };
    sync: { declared: boolean; fixtures: number; passed: number };
  };
  fixtures: FixtureResult[];
  /** True when every declared capability has all fixtures passing. */
  green: boolean;
  /** Set when the run could not execute (e.g. live mode without creds). */
  skipped?: string;
}

export interface RunOptions {
  /** Run fixtures against a real Nango connection instead of the mock. */
  live?: boolean;
  /** Live Nango connection ids keyed by providerConfigKey. */
  liveConnections?: Record<string, string>;
  /** Restrict to a subset of directions. */
  directions?: Direction[];
}
