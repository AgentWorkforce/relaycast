import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  organizations,
  relayWorkspaces,
  users,
  workspaceIntegrations,
  workspaces,
} from "@cloud/core/db/schema.js";

export * from "@cloud/core/db/schema.js";

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });
const uuidColumn = (name: string) => uuid(name);

export const cloudCliBootstrapSessions = pgTable(
  "cloud_cli_bootstrap_sessions",
  {
    id: text("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    provider: text("provider").notNull(),
    language: text("language").notNull(),
    home: text("home").notNull(),
    userId: uuidColumn("user_id").notNull(),
    daytonaApiKey: text("daytona_api_key"),
    daytonaJwtToken: text("daytona_jwt_token"),
    daytonaOrganizationId: text("daytona_organization_id"),
    sshToken: text("ssh_token").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => ({
    sandboxUnique: uniqueIndex("cloud_cli_bootstrap_sessions_sandbox_unique").on(table.sandboxId),
    userIndex: index("idx_cloud_cli_bootstrap_sessions_user").on(table.userId),
    expiresAtIndex: index("idx_cloud_cli_bootstrap_sessions_expires_at").on(table.expiresAt),
  }),
);

export const workforceCliAuthSessions = pgTable(
  "workforce_cli_auth_sessions",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    userId: uuidColumn("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    state: text("state").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    tokenHash: text("token_hash"),
    issuedAt: timestampColumn("issued_at").notNull().defaultNow(),
    exchangedAt: timestampColumn("exchanged_at"),
    expiresAt: timestampColumn("expires_at").notNull(),
    revokedAt: timestampColumn("revoked_at"),
  },
  (table) => ({
    userIndex: index("idx_workforce_cli_auth_sessions_user").on(table.userId),
    stateUnique: uniqueIndex("workforce_cli_auth_sessions_state_unique").on(table.state),
    expiresAtIndex: index("idx_workforce_cli_auth_sessions_expires_at").on(table.expiresAt),
  }),
);

export const personas = pgTable(
  "personas",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    ownerUserId: uuidColumn("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuidColumn("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    visibility: text("visibility").notNull().default("private"),
    slug: text("slug").notNull(),
    intent: text("intent"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    description: text("description"),
    harnessKind: text("harness_kind"),
    model: text("model"),
    useSubscription: boolean("use_subscription").notNull().default(false),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    ownerSlugUnique: uniqueIndex("personas_owner_slug_unique").on(table.ownerUserId, table.slug),
    orgVisibleIndex: index("idx_personas_org_visible")
      .on(table.organizationId)
      .where(sql`${table.visibility} = 'organization'`),
    intentIndex: index("idx_personas_intent").on(table.intent),
    tagsIndex: index("idx_personas_tags").using("gin", table.tags),
  }),
);

export const personaVersions = pgTable(
  "persona_versions",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    personaId: uuidColumn("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    /**
     * SHA256 hex of the persona's deploy bundle (runner.mjs +
     * agent.bundle.mjs + package.json). Content-addressed pointer into
     * the `WorkflowStorage` S3 bucket at
     * `persona-bundles/<sha256>.json`. The tick handler reads the
     * bundle by this hash when provisioning a sandbox on-demand under
     * the cold-start runtime model (cloud#604).
     *
     * Nullable to keep pre-cold-start rows valid; new deploys always
     * populate it.
     */
    bundleSha256: text("bundle_sha256"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    personaVersionUnique: uniqueIndex("persona_versions_persona_version_unique").on(
      table.personaId,
      table.version,
    ),
    personaSpecHashUnique: uniqueIndex("persona_versions_persona_spec_hash_unique").on(
      table.personaId,
      table.specHash,
    ),
  }),
);

export const userIntegrations = pgTable(
  "user_integrations",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    userId: uuidColumn("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    adapter: text("adapter").notNull().default("nango"),
    name: text("name"),
    connectionId: text("connection_id").notNull(),
    providerConfigKey: text("provider_config_key"),
    installationId: text("installation_id"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userProviderDefaultUnique: uniqueIndex("user_integrations_user_provider_default_unique")
      .on(table.userId, table.provider)
      .where(sql`${table.name} IS NULL`),
    userProviderNameUnique: uniqueIndex("user_integrations_user_provider_name_unique")
      .on(table.userId, table.provider, table.name)
      .where(sql`${table.name} IS NOT NULL`),
    providerConnectionUnique: uniqueIndex("user_integrations_provider_connection_unique").on(
      table.provider,
      table.connectionId,
    ),
  }),
);

export const integrationScopes = pgTable(
  "integration_scopes",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    userIntegrationId: uuidColumn("user_integration_id").references(() => userIntegrations.id, {
      onDelete: "cascade",
    }),
    workspaceIntegrationId: uuidColumn("workspace_integration_id").references(
      () => workspaceIntegrations.id,
      { onDelete: "cascade" },
    ),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userUnique: uniqueIndex("integration_scopes_user_unique")
      .on(table.userIntegrationId, table.scopeKind, table.scopeId)
      .where(sql`${table.userIntegrationId} IS NOT NULL`),
    workspaceUnique: uniqueIndex("integration_scopes_workspace_unique")
      .on(table.workspaceIntegrationId, table.scopeKind, table.scopeId)
      .where(sql`${table.workspaceIntegrationId} IS NOT NULL`),
    scopeKindIndex: index("idx_integration_scopes_scope_kind").on(table.scopeKind),
  }),
);

export const relayfileWritebackReceipts = pgTable(
  "relayfile_writeback_receipts",
  {
    workspaceId: text("workspace_id").notNull(),
    opId: text("op_id").notNull(),
    provider: text("provider").notNull(),
    outcome: text("outcome").notNull().$type<"success" | "permanent_failure">(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ackedAt: timestampColumn("acked_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "relayfile_writeback_receipts_pk",
      columns: [table.workspaceId, table.opId],
    }),
    outcomeCheck: check(
      "relayfile_writeback_receipts_outcome_check",
      sql`${table.outcome} IN ('success','permanent_failure')`,
    ),
    expiresAtIndex: index("relayfile_writeback_receipts_expires_idx").on(table.expiresAt),
  }),
);

export const slackDirectProxyWritebackIdempotency = pgTable(
  "slack_direct_proxy_writeback_idempotency",
  {
    workspaceId: text("workspace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerConfigKey: text("provider_config_key").notNull(),
    connectionId: text("connection_id").notNull(),
    status: text("status").notNull().$type<"pending" | "success" | "permanent_failure">(),
    opId: text("op_id"),
    slackTs: text("slack_ts"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "slack_direct_proxy_writeback_idempotency_pk",
      columns: [table.workspaceId, table.idempotencyKey],
    }),
    statusCheck: check(
      "slack_direct_proxy_writeback_idempotency_status_check",
      sql`${table.status} IN ('pending','success','permanent_failure')`,
    ),
    expiresAtIndex: index("slack_direct_proxy_writeback_idempotency_expires_idx").on(table.expiresAt),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personaId: uuidColumn("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    deployedName: text("deployed_name").notNull(),
    imageUrl: text("image_url"),
    deployedByUserId: uuidColumn("deployed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    credentialSelections: jsonb("credential_selections")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    inputValues: jsonb("input_values").$type<Record<string, string>>().notNull().default({}),
    pinnedVersionId: uuidColumn("pinned_version_id").references(() => personaVersions.id, {
      onDelete: "set null",
    }),
    specHashAtDeploy: text("spec_hash_at_deploy").notNull(),
    status: text("status").notNull().default("active"),
    destroyedAt: timestampColumn("destroyed_at"),
    destroyedByUserId: uuidColumn("destroyed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    spawnedByAgentId: uuidColumn("spawned_by_agent_id").references((): AnyPgColumn => agents.id, {
      onDelete: "set null",
    }),
    watchGlobs: text("watch_globs").array(),
    watchRules: jsonb("watch_rules").$type<unknown[] | null>(),
    inboxSelectors: text("inbox_selectors").array(),
    deliveryMaxConcurrency: integer("delivery_max_concurrency"),
    deliveryMaxConcurrencyByTrigger: jsonb("delivery_max_concurrency_by_trigger")
      .$type<Record<string, number> | null>(),
    scheduleIds: text("schedule_ids").array(),
    lastUsedAt: timestampColumn("last_used_at"),
    lastError: text("last_error"),
    // Proactive-unification PR-1.1 (canonical-spec §6 persona executor).
    // Migration 0056 introduces these as additive nullable / defaulted columns
    // so existing rows fall back to the ephemeral-sandbox runtime behavior
    // until PR-2.1 wires `executor.kind` branching into the dispatcher.
    executor: jsonb("executor")
      .$type<AgentExecutor>()
      .notNull()
      .default(sql`'{"kind":"ephemeral-sandbox"}'::jsonb`),
    ownerService: text("owner_service"),
    sourceTag: text("source_tag"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspacePersonaLiveUnique: uniqueIndex("agents_workspace_persona_live_unique")
      .on(table.workspaceId, table.personaId)
      .where(sql`${table.status} != 'destroyed'`),
    workspaceDeployedNameLiveUnique: uniqueIndex("agents_workspace_deployed_name_live_unique")
      .on(table.workspaceId, table.deployedName)
      .where(sql`${table.status} != 'destroyed'`),
    workspaceStatusIndex: index("idx_agents_workspace_status").on(table.workspaceId, table.status),
    spawnedByAgentIndex: index("idx_agents_spawned_by_agent").on(table.spawnedByAgentId),
    ownerServiceDeployedNameIndex: index("idx_agents_owner_service_deployed_name").on(
      table.ownerService,
      table.deployedName,
    ),
  }),
);

/**
 * Mirror of canonical-spec §6 PersonaExecutor discriminated union, persisted
 * as JSON on the `agents.executor` column. PR-2.1 will branch the dispatcher
 * on `executor.kind`; until then, all agents resolve back to today's
 * ephemeral-sandbox runtime behavior regardless of stored value.
 */
export type AgentExecutor =
  | { kind: "ephemeral-sandbox" }
  | {
      kind: "http-delegate";
      router: {
        kind: string;
        url: string;
        auth: { kind: string; envVar: string };
        timeoutSeconds: number;
        healthcheck?: string;
      };
    }
  | {
      kind: "hybrid";
      router: {
        kind: string;
        url: string;
        auth: { kind: string; envVar: string };
        timeoutSeconds: number;
        healthcheck?: string;
      };
      sandbox: {
        snapshot: string;
        lifecycle: "warm-pool" | "ephemeral";
        reuseLabels?: string[];
        idleStopMinutes?: number;
        borrowProtocol: "v1";
        maxConcurrentBorrows: number;
        borrowEndpoint?: string;
        releaseEndpoint?: string;
      };
    };

export const agentDeployments = pgTable(
  "agent_deployments",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    agentId: uuidColumn("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    triggerKind: text("trigger_kind").notNull().default("inbox"),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    startedAt: timestampColumn("started_at").notNull().defaultNow(),
    lastActiveAt: timestampColumn("last_active_at").notNull().defaultNow(),
    status: text("status").notNull().default("running"),
    specHashAtRun: text("spec_hash_at_run"),
    timedOutAt: timestampColumn("timed_out_at"),
    compactionSummary: text("compaction_summary"),
    parentDeploymentId: uuidColumn("parent_deployment_id").references(
      (): AnyPgColumn => agentDeployments.id,
      { onDelete: "set null" },
    ),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    agentStatusIndex: index("idx_agent_deployments_agent_status").on(table.agentId, table.status),
    parentIndex: index("idx_agent_deployments_parent").on(table.parentDeploymentId),
  }),
);

export const agentDeploymentRuns = pgTable(
  "agent_deployment_runs",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    deploymentId: uuidColumn("deployment_id")
      .notNull()
      .references(() => agentDeployments.id, { onDelete: "cascade" }),
    agentId: uuidColumn("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    eventSource: text("event_source").notNull().default("unknown"),
    sandboxId: text("sandbox_id"),
    sandboxName: text("sandbox_name"),
    stdout: text("stdout").default(""),
    stdoutTruncated: boolean("stdout_truncated").notNull().default(false),
    stderr: text("stderr").default(""),
    stderrTruncated: boolean("stderr_truncated").notNull().default(false),
    mountLogTail: text("mount_log_tail").default(""),
    envelope: text("envelope"),
    envelopeOmitted: boolean("envelope_omitted").notNull().default(false),
    exitCode: integer("exit_code"),
    cleanupStatus: jsonb("cleanup_status")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestampColumn("started_at").notNull(),
    endedAt: timestampColumn("ended_at").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
    summary: text("summary"),
    compressedAt: timestampColumn("compressed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    agentStartedIndex: index("idx_agent_deployment_runs_agent_started").on(
      table.agentId,
      table.startedAt.desc(),
    ),
    deploymentStartedIndex: index("idx_agent_deployment_runs_deployment_started").on(
      table.deploymentId,
      table.startedAt.desc(),
    ),
    statusIndex: index("idx_agent_deployment_runs_status").on(table.status),
    compressedIndex: index("idx_agent_deployment_runs_compressed_at").on(table.compressedAt),
  }),
);

export const integrationWatchDeliveries = pgTable(
  "integration_watch_deliveries",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuidColumn("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    triggerKey: text("trigger_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
    leaseUntil: timestampColumn("lease_until"),
    provisioningSandboxId: text("provisioning_sandbox_id"),
    runDeploymentId: uuidColumn("run_deployment_id"),
    runSandboxId: text("run_sandbox_id"),
    runSessionId: text("run_session_id"),
    runCommandId: text("run_command_id"),
    runStartedAt: timestampColumn("run_started_at"),
    runSandboxName: text("run_sandbox_name"),
    runMountConfigured: boolean("run_mount_configured"),
    terminalWritebackStatus: text("terminal_writeback_status"),
    terminalWritebackPostedAt: timestampColumn("terminal_writeback_posted_at"),
    terminalWritebackError: text("terminal_writeback_error"),
    slackTerminalReplyStatus: text("slack_terminal_reply_status"),
    slackTerminalReplyPostedAt: timestampColumn("slack_terminal_reply_posted_at"),
    slackTerminalReplyError: text("slack_terminal_reply_error"),
    lastError: text("last_error"),
    deliveredAt: timestampColumn("delivered_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    deliveryUnique: uniqueIndex("integration_watch_deliveries_delivery_unique").on(
      table.workspaceId,
      table.agentId,
      table.deliveryId,
    ),
    pendingIndex: index("idx_integration_watch_deliveries_pending").on(
      table.workspaceId,
      table.agentId,
      table.status,
      table.nextAttemptAt,
    ),
    agentTriggerStatusIndex: index("idx_integration_watch_deliveries_agent_trigger_status").on(
      table.agentId,
      table.status,
      table.nextAttemptAt,
      table.triggerKey,
    ),
    statusLeaseIndex: index("idx_integration_watch_deliveries_status_lease").on(
      table.status,
      table.leaseUntil,
    ),
  }),
);

export const integrationWatchDispatchFailures = pgTable(
  "integration_watch_dispatch_failures",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    relayWorkspaceId: text("relay_workspace_id").notNull(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    connectionId: text("connection_id"),
    deliveryId: text("delivery_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("failed"),
    reason: text("reason").notNull(),
    error: text("error"),
    occurredAt: timestampColumn("occurred_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "integration_watch_dispatch_failures_status_valid",
      sql`${table.status} IN ('failed', 'replayed', 'ignored')`,
    ),
    failureUnique: uniqueIndex("integration_watch_dispatch_failures_unique").on(
      table.relayWorkspaceId,
      table.provider,
      table.eventType,
      table.deliveryId,
    ),
    reasonCreatedIndex: index("idx_integration_watch_dispatch_failures_reason_created").on(
      table.reason,
      table.createdAt,
    ),
    relayWorkspaceIndex: index("idx_integration_watch_dispatch_failures_relay_workspace").on(
      table.relayWorkspaceId,
    ),
  }),
);

export const deploymentTickDeliveries = pgTable(
  "deployment_tick_deliveries",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuidColumn("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
    leaseUntil: timestampColumn("lease_until"),
    provisioningSandboxId: text("provisioning_sandbox_id"),
    runDeploymentId: uuidColumn("run_deployment_id"),
    runSandboxId: text("run_sandbox_id"),
    runSessionId: text("run_session_id"),
    runCommandId: text("run_command_id"),
    runStartedAt: timestampColumn("run_started_at"),
    runSandboxName: text("run_sandbox_name"),
    runMountConfigured: boolean("run_mount_configured"),
    runEnvelope: text("run_envelope"),
    lastError: text("last_error"),
    deliveredAt: timestampColumn("delivered_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    deliveryUnique: uniqueIndex("deployment_tick_deliveries_delivery_unique").on(
      table.workspaceId,
      table.agentId,
      table.deliveryId,
    ),
    pendingIndex: index("idx_deployment_tick_deliveries_pending").on(
      table.workspaceId,
      table.agentId,
      table.status,
      table.nextAttemptAt,
    ),
    statusLeaseIndex: index("idx_deployment_tick_deliveries_status_lease").on(
      table.status,
      table.leaseUntil,
    ),
  }),
);

export const integrationWatchIssueDispatchDedup = pgTable(
  "integration_watch_issue_dispatch_dedup",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    issueKey: text("issue_key").notNull(),
    agentId: uuidColumn("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    claimedAt: timestampColumn("claimed_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
    pendingDeliveryId: text("pending_delivery_id"),
    pendingPayload: jsonb("pending_payload"),
  },
  (table) => ({
    uniqueClaim: uniqueIndex("integration_watch_issue_dispatch_dedup_unique").on(
      table.workspaceId,
      table.issueKey,
      table.agentId,
    ),
  }),
);

export const proactiveContinuations = pgTable(
  "proactive_continuations",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    status: text("status").notNull(),
    waitForType: text("wait_for_type").notNull(),
    correlation: text("correlation"),
    record: jsonb("record").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    sessionIndex: index("idx_proactive_continuations_session_id").on(table.sessionId),
    waitForTypeIndex: index("idx_proactive_continuations_wait_for_type").on(
      table.waitForType,
    ),
    correlationIndex: index("idx_proactive_continuations_correlation").on(
      table.correlation,
    ),
  }),
);

export const slackConversationThreads = pgTable(
  "slack_conversation_threads",
  {
    workspaceId: text("workspace_id").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    deployedName: text("deployed_name").notNull(),
    agentId: text("agent_id").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.workspaceId, table.channel, table.threadTs],
    }),
  }),
);

export const workspaceDigestFunctions = pgTable(
  "workspace_digest_functions",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active").$type<"active" | "disabled">(),
    runtime: text("runtime").notNull().default("node20"),
    entrypoint: text("entrypoint").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceSize: integer("source_size").notNull(),
    compiledArtifactRef: text("compiled_artifact_ref").notNull(),
    signature: text("signature").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    deployedByUserId: uuidColumn("deployed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    disabledAt: timestampColumn("disabled_at"),
    disabledByUserId: uuidColumn("disabled_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    lastInvokedAt: timestampColumn("last_invoked_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "workspace_digest_functions_status_valid",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
    workspaceSlugLiveUnique: uniqueIndex(
      "workspace_digest_functions_workspace_slug_live_unique",
    )
      .on(table.workspaceId, table.slug)
      .where(sql`${table.status} <> 'disabled'`),
    workspaceStatusIndex: index(
      "idx_workspace_digest_functions_workspace_status",
    ).on(table.workspaceId, table.status),
    sourceHashIndex: index("idx_workspace_digest_functions_source_hash").on(
      table.sourceHash,
    ),
  }),
);

export const slackRelayMessageDirection = pgEnum("slack_relay_message_direction", [
  "slack_to_relay",
  "relay_to_slack",
]);

export const slackRelayLinks = pgTable(
  "slack_relay_links",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => relayWorkspaces.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id").notNull(),
    relayChannelId: text("relay_channel_id").notNull(),
    createdBy: uuidColumn("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspaceSlackRelayUnique: uniqueIndex(
      "slack_relay_links_workspace_slack_relay_unique",
    ).on(table.workspaceId, table.slackChannelId, table.relayChannelId),
    workspaceIndex: index("idx_slack_relay_links_workspace").on(table.workspaceId),
    slackChannelIndex: index("idx_slack_relay_links_slack_channel").on(
      table.slackChannelId,
    ),
  }),
);

export const slackRelayMessages = pgTable(
  "slack_relay_messages",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    linkId: uuidColumn("link_id")
      .notNull()
      .references(() => slackRelayLinks.id, { onDelete: "cascade" }),
    direction: slackRelayMessageDirection("direction").notNull(),
    slackTs: text("slack_ts").notNull(),
    relayMessageId: text("relay_message_id").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    linkSlackDirectionUnique: uniqueIndex(
      "slack_relay_messages_link_slack_direction_unique",
    ).on(table.linkId, table.slackTs, table.direction),
    slackTsIndex: index("idx_slack_relay_messages_slack_ts").on(table.slackTs),
    relayMessageIdIndex: index("idx_slack_relay_messages_relay_message_id").on(
      table.relayMessageId,
    ),
    linkSeqIndex: index("idx_slack_relay_messages_link_seq").on(table.linkId, table.seq),
  }),
);

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentAgentId: uuidColumn("parent_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    parentDeploymentId: uuidColumn("parent_deployment_id").references(
      () => agentDeployments.id,
      { onDelete: "set null" },
    ),
    slug: text("slug"),
    status: text("status").notNull().default("starting"),
    task: text("task"),
    teamPrompt: text("team_prompt"),
    leadMemberName: text("lead_member_name"),
    delegation: jsonb("delegation").$type<unknown[]>(),
    tokenBudget: integer("token_budget"),
    timeBudgetSeconds: integer("time_budget_seconds"),
    spec: jsonb("spec").$type<Record<string, unknown>>(),
    sharedMountRoot: text("shared_mount_root"),
    channel: text("channel"),
    ttlSeconds: integer("ttl_seconds"),
    expiresAt: timestampColumn("expires_at"),
    summary: text("summary"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "teams_status_valid",
      sql`${table.status} IN ('active', 'starting', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')`,
    ),
    delegationCheck: check(
      "teams_delegation_array_valid",
      sql`${table.delegation} IS NULL OR jsonb_typeof(${table.delegation}) = 'array'`,
    ),
    tokenBudgetCheck: check(
      "teams_token_budget_positive",
      sql`${table.tokenBudget} IS NULL OR ${table.tokenBudget} > 0`,
    ),
    timeBudgetCheck: check(
      "teams_time_budget_seconds_positive",
      sql`${table.timeBudgetSeconds} IS NULL OR ${table.timeBudgetSeconds} > 0`,
    ),
    slugCheck: check(
      "teams_slug_non_empty",
      sql`${table.slug} IS NULL OR length(btrim(${table.slug})) > 0`,
    ),
    specCheck: check(
      "teams_spec_object_valid",
      sql`${table.spec} IS NULL OR jsonb_typeof(${table.spec}) = 'object'`,
    ),
    workspaceSlugUnique: uniqueIndex("teams_workspace_slug_unique")
      .on(table.workspaceId, table.slug),
    workspaceStatusIndex: index("idx_teams_workspace_status").on(
      table.workspaceId,
      table.status,
    ),
    parentAgentIndex: index("idx_teams_parent_agent").on(table.parentAgentId),
    expiresAtIndex: index("idx_teams_expires_at").on(table.expiresAt),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    agentId: uuidColumn("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    personaId: text("persona_id"),
    personaRef: jsonb("persona_ref").$type<unknown>(),
    role: text("role").notNull().default("worker"),
    owns: jsonb("owns").$type<unknown[]>(),
    sandboxId: text("sandbox_id"),
    assignedTask: text("assigned_task"),
    status: text("status").notNull().default("starting"),
    resultId: text("result_id"),
    output: text("output"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    teamNameUnique: uniqueIndex("team_members_team_name_unique").on(table.teamId, table.name),
    teamOrchestratorUnique: uniqueIndex("team_members_team_orchestrator_unique")
      .on(table.teamId)
      .where(sql`${table.role} = 'orchestrator'`),
    roleCheck: check(
      "team_members_role_valid",
      sql`length(btrim(${table.role})) > 0`,
    ),
    statusCheck: check(
      "team_members_status_valid",
      sql`${table.status} IN ('starting', 'running', 'succeeded', 'failed', 'timed_out')`,
    ),
    personaRefCheck: check(
      "team_members_persona_ref_valid",
      sql`${table.personaRef} IS NULL OR jsonb_typeof(${table.personaRef}) IN ('string', 'object')`,
    ),
    ownsCheck: check(
      "team_members_owns_array_valid",
      sql`${table.owns} IS NULL OR jsonb_typeof(${table.owns}) = 'array'`,
    ),
    teamIndex: index("idx_team_members_team").on(table.teamId),
    agentIndex: index("idx_team_members_agent").on(table.agentId),
  }),
);

export const teamEvents = pgTable(
  "team_events",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    memberName: text("member_name"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    teamCreatedIndex: index("idx_team_events_team_created").on(table.teamId, table.createdAt),
  }),
);
