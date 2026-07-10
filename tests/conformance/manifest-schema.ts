// Conformance manifest schema + validator.
//
// A manifest is the single source of truth for one integration's conformance
// coverage. The runner drives all declared capabilities through the REAL code
// path (record-writer / writeback-bridge / webhook-router) with ONLY the outer
// boundary (Nango SDK + provider HTTP + relayfile persistence) mocked.
//
// See ./README.md for the authoring guide and the RUNBOOK
// (.agentworkforce/overnight-integration-run/RUNBOOK.md) for the chain
// definition + GATE CONTRACT.

export interface ManifestCapabilities {
  webhook: boolean;
  /**
   * Cloud-bridge writeback proof:
   *  - true  → provider is cloud-integrated; the writeback runner proves the
   *            real bridge chain (executeRelayfileProviderWriteback). Requires
   *            writeback fixtures.
   *  - "adapter-only" → provider HAS writeback, but it is NOT cloud-bridged
   *            (no Nango integration / connection). Its writeback is proven at
   *            the adapter layer (adapter resolver tests), not by this runner.
   *            The cloud writeback runner does not run for it.
   *  - false → no writeback at all (e.g. read-only providers).
   */
  writeback: boolean | "adapter-only";
  sync: boolean;
}

/** Inbound: provider webhook -> nango-webhook-router -> adapter -> relayfile write. */
export interface InboundFixture {
  /** Human label, e.g. "issues.opened". */
  event: string;
  /** Where the payload shape came from (docs URL / nango-template path / file). */
  source?: string;
  /** Nango webhook envelope inputs (defaults derived from manifest top-level). */
  type?: string; // default "forward"
  from?: string; // default nangoIntegration
  providerConfigKey?: string; // default nangoIntegration
  connectionId?: string; // default harness default connection id
  /** Connection metadata seeded into the mocked workspace_integration record. */
  metadata?: Record<string, unknown>;
  /** The webhook payload (provider event body / {headers,body}) — doc accurate. */
  payload: unknown;
  /**
   * Canned Nango proxy responses for inbound enrichment calls (e.g. Slack
   * resolves a channel name via /conversations.info before writing). Each entry
   * matches by endpoint regex (and optional method); first match wins. Without
   * a match the mock returns { status: 200, body: {} }.
   */
  mockNango?: Array<{
    endpointMatches?: string;
    method?: string;
    status?: number;
    body?: unknown;
  }>;
  expect: {
    /** Each exact path must appear in the captured relayfile writes[]. */
    paths?: string[];
    /** Each regex (string) must match at least one captured write path. */
    pathPatterns?: string[];
    /** Substrings that must appear in the content of at least one matched write. */
    contentIncludes?: string[];
    /** Minimum number of relayfile writes expected (default: 1). */
    minWrites?: number;
    /** Thin notification webhooks prove they triggered exact Nango syncs instead of direct writes. */
    triggersSync?: Array<{
      syncName: string;
      providerConfigKey?: string;
      connectionId?: string;
    }>;
    /** Watch-only webhooks prove they dispatched the exact integration-watch event. */
    triggersWatch?: Array<{
      provider: string;
      eventType: string;
      path?: string;
      pathPattern?: string;
      connectionId?: string;
    }>;
  };
}

/** Outbound: relayfile write -> writeback-bridge.executeRelayfileProviderWriteback -> Nango action/proxy. */
export interface WritebackFixture {
  /** Human label of the provider action, e.g. "create-issue-comment". */
  action: string;
  /** Where the expected provider call shape came from (provider API docs / template). */
  source?: string;
  /** Writeback event sent to the bridge (default file_upsert; use file_delete for delete coverage). */
  fileAction?: "file_upsert" | "file_delete";
  /** relayfile path being written back (selects the provider executor). */
  filePath: string;
  /** File content: object -> JSON.stringify, string -> used as-is. */
  content: unknown;
  /** Optional content type passed to the bridge (default application/json). */
  contentType?: string;
  /**
   * Connection metadata seeded into the mocked workspace_integration record,
   * mirroring how a real Nango connection's connection_config looks. Required
   * by providers that read connection metadata before proxying — e.g. Atlassian
   * Cloud needs { connection_config: { cloudId: "..." } } to build
   * /ex/jira/{cloudId}/... endpoints.
   */
  metadata?: Record<string, unknown>;
  /** What the mocked Nango/provider boundary returns so the executor succeeds. */
  mockResponse?: { status?: number; body?: unknown };
  expectCall: {
    method: string;
    /** Exact endpoint match (the path part Nango proxies to the provider). */
    endpoint?: string;
    /** Regex (string) the captured endpoint must match. */
    endpointMatches?: string;
    /** Deep-subset match against the captured outbound request body. */
    bodyIncludes?: Record<string, unknown>;
    connectionId?: string;
    providerConfigKey?: string;
  };
  /** Expected bridge outcome (default "success"). */
  expectOutcome?: "success" | "permanent_failure" | "retryable_failure";
}

/** Sync: Nango model records -> record-writer.writeBatchToRelayfile -> relayfile write/delete. */
export interface SyncExpect {
  /** Exact path expected in writes[] (or deletes[] when op === "delete"). */
  path?: string;
  /** Regex (string) that must match at least one write/delete path. */
  pathPattern?: string;
  /** "write" (default) or "delete". */
  op?: "write" | "delete";
  /** Substrings that must appear in the matched write content. */
  contentIncludes?: string[];
}

export interface SyncFixture {
  /** Nango model name, e.g. "LinearIssue". */
  model: string;
  /** Nango sync name, e.g. "fetch-active-issues". */
  syncName: string;
  /** Source of the record shape (provider docs / nango-template model). */
  source?: string;
  /**
   * Optional records written FIRST (same client/store) before `records`, so a
   * delete fixture has a prior file to reconcile against. Deletion in
   * record-writer reads the canonical/alias/index files to know what to remove;
   * against a fresh store there is nothing to delete. Captured writes/deletes
   * are reset after seeding, so assertions apply only to `records`.
   */
  seedRecords?: unknown[];
  /** Nango model record rows (deletes carry _nango_metadata.last_action="deleted"). */
  records: unknown[];
  expect: SyncExpect[];
}

export interface ConformanceManifest {
  provider: string;
  /**
   * Nango providerConfigKey for this integration (e.g. "linear-relay"). May be
   * null/omitted for adapter-only providers that have no concrete
   * cloud/nango-integrations/*-relay folder. When absent, runners derive a
   * providerConfigKey of `${provider}-relay` (overridable per fixture).
   */
  nangoIntegration?: string | null;
  adapterPackage?: string;
  capabilities: ManifestCapabilities;
  inbound?: InboundFixture[];
  writeback?: WritebackFixture[];
  sync?: SyncFixture[];
}

/** Resolve the providerConfigKey for a fixture given precedence rules. */
export function resolveProviderConfigKey(
  manifest: { provider: string; nangoIntegration?: string | null },
  fixtureOverride?: string | null,
): string {
  if (typeof fixtureOverride === "string" && fixtureOverride.length > 0) {
    return fixtureOverride;
  }
  if (
    typeof manifest.nangoIntegration === "string" &&
    manifest.nangoIntegration.length > 0
  ) {
    return manifest.nangoIntegration;
  }
  return `${manifest.provider}-relay`;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed manifest object. Returns all errors (does not throw) so the
 * loader can report every problem in a file at once.
 */
export function validateManifest(
  raw: unknown,
  label = "manifest",
): ValidationResult {
  const errors: string[] = [];
  const push = (msg: string) => errors.push(`${label}: ${msg}`);

  if (!isObject(raw)) {
    return { valid: false, errors: [`${label}: must be a JSON object`] };
  }

  if (typeof raw.provider !== "string" || raw.provider.length === 0) {
    push("`provider` is required and must be a non-empty string");
  }
  // `nangoIntegration` is optional: adapter-only providers (no concrete
  // cloud/nango-integrations/*-relay folder) may set it null or omit it.
  if (
    raw.nangoIntegration !== undefined &&
    raw.nangoIntegration !== null &&
    (typeof raw.nangoIntegration !== "string" || raw.nangoIntegration.length === 0)
  ) {
    push("`nangoIntegration` must be a non-empty string, null, or omitted");
  }

  const caps = raw.capabilities;
  if (!isObject(caps)) {
    push("`capabilities` is required and must be an object");
  } else {
    for (const key of ["webhook", "sync"] as const) {
      if (typeof caps[key] !== "boolean") {
        push(`capabilities.${key} must be a boolean`);
      }
    }
    if (typeof caps.writeback !== "boolean" && caps.writeback !== "adapter-only") {
      push('capabilities.writeback must be a boolean or the string "adapter-only"');
    }
  }

  const declared = isObject(caps) ? caps : {};

  // Each declared capability must have at least one fixture, and each fixture
  // section must be a well-formed array.
  if (declared.webhook === true) {
    if (!Array.isArray(raw.inbound) || raw.inbound.length === 0) {
      push("capabilities.webhook is true but `inbound` has no fixtures");
    } else {
      raw.inbound.forEach((fx, i) => validateInbound(fx, `${label}.inbound[${i}]`, push));
    }
  }
  if (declared.writeback === true) {
    if (!Array.isArray(raw.writeback) || raw.writeback.length === 0) {
      push("capabilities.writeback is true but `writeback` has no fixtures");
    } else {
      raw.writeback.forEach((fx, i) => validateWriteback(fx, `${label}.writeback[${i}]`, push));
    }
  }
  if (declared.sync === true) {
    if (!Array.isArray(raw.sync) || raw.sync.length === 0) {
      push("capabilities.sync is true but `sync` has no fixtures");
    } else {
      raw.sync.forEach((fx, i) => validateSync(fx, `${label}.sync[${i}]`, push));
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateInbound(
  fx: unknown,
  label: string,
  push: (m: string) => void,
): void {
  if (!isObject(fx)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof fx.event !== "string") push(`${label}.event must be a string`);
  if (fx.payload === undefined) push(`${label}.payload is required`);
  if (!isObject(fx.expect)) {
    push(`${label}.expect is required`);
    return;
  }
  const e = fx.expect;
  const hasPathAssertion =
    Array.isArray(e.paths) ||
    Array.isArray(e.pathPatterns) ||
    typeof e.minWrites === "number" ||
    Array.isArray(e.triggersSync) ||
    Array.isArray(e.triggersWatch);
  if (!hasPathAssertion) {
    push(`${label}.expect must declare paths, pathPatterns, minWrites, triggersSync, or triggersWatch`);
  }
  if (e.triggersSync !== undefined) {
    if (!Array.isArray(e.triggersSync) || e.triggersSync.length === 0) {
      push(`${label}.expect.triggersSync must be a non-empty array when provided`);
    } else {
      e.triggersSync.forEach((trigger, i) => {
        if (!isObject(trigger)) {
          push(`${label}.expect.triggersSync[${i}] must be an object`);
          return;
        }
        if (typeof trigger.syncName !== "string" || trigger.syncName.length === 0) {
          push(`${label}.expect.triggersSync[${i}].syncName must be a non-empty string`);
        }
      });
    }
  }
  if (e.triggersWatch !== undefined) {
    if (!Array.isArray(e.triggersWatch) || e.triggersWatch.length === 0) {
      push(`${label}.expect.triggersWatch must be a non-empty array when provided`);
    } else {
      e.triggersWatch.forEach((trigger, i) => {
        if (!isObject(trigger)) {
          push(`${label}.expect.triggersWatch[${i}] must be an object`);
          return;
        }
        if (typeof trigger.provider !== "string" || trigger.provider.length === 0) {
          push(`${label}.expect.triggersWatch[${i}].provider must be a non-empty string`);
        }
        if (typeof trigger.eventType !== "string" || trigger.eventType.length === 0) {
          push(`${label}.expect.triggersWatch[${i}].eventType must be a non-empty string`);
        }
        if (trigger.path !== undefined && typeof trigger.path !== "string") {
          push(`${label}.expect.triggersWatch[${i}].path must be a string when provided`);
        }
        if (trigger.pathPattern !== undefined && typeof trigger.pathPattern !== "string") {
          push(`${label}.expect.triggersWatch[${i}].pathPattern must be a string when provided`);
        }
      });
    }
  }
}

function validateWriteback(
  fx: unknown,
  label: string,
  push: (m: string) => void,
): void {
  if (!isObject(fx)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof fx.action !== "string") push(`${label}.action must be a string`);
  if (
    fx.fileAction !== undefined &&
    fx.fileAction !== "file_upsert" &&
    fx.fileAction !== "file_delete"
  ) {
    push(`${label}.fileAction must be "file_upsert" or "file_delete"`);
  }
  if (typeof fx.filePath !== "string") push(`${label}.filePath must be a string`);
  if (fx.content === undefined) push(`${label}.content is required`);
  if (!isObject(fx.expectCall)) {
    push(`${label}.expectCall is required`);
    return;
  }
  const c = fx.expectCall;
  if (typeof c.method !== "string") push(`${label}.expectCall.method must be a string`);
  if (typeof c.endpoint !== "string" && typeof c.endpointMatches !== "string") {
    push(`${label}.expectCall must declare endpoint or endpointMatches`);
  }
}

function validateSync(
  fx: unknown,
  label: string,
  push: (m: string) => void,
): void {
  if (!isObject(fx)) {
    push(`${label} must be an object`);
    return;
  }
  if (typeof fx.model !== "string") push(`${label}.model must be a string`);
  if (typeof fx.syncName !== "string") push(`${label}.syncName must be a string`);
  if (!Array.isArray(fx.records) || fx.records.length === 0) {
    push(`${label}.records must be a non-empty array`);
  }
  if (!Array.isArray(fx.expect) || fx.expect.length === 0) {
    push(`${label}.expect must be a non-empty array`);
    return;
  }
  fx.expect.forEach((ex, i) => {
    if (!isObject(ex)) {
      push(`${label}.expect[${i}] must be an object`);
      return;
    }
    if (typeof ex.path !== "string" && typeof ex.pathPattern !== "string") {
      push(`${label}.expect[${i}] must declare path or pathPattern`);
    }
  });
}
