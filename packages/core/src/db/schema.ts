import { sql } from "drizzle-orm";
import { bigint, boolean, index, inet, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });
const uuidColumn = (name: string) => uuid(name);

type EncryptedEnvelopeJson = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export const users = pgTable("users", {
  id: uuidColumn("id").primaryKey(),
  primaryEmail: text("primary_email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  cloudAgentSpawnQuotaOverride: integer("cloud_agent_spawn_quota_override"),
  lastOrganizationId: uuidColumn("last_organization_id"),
  lastWorkspaceId: uuidColumn("last_workspace_id"),
  createdAt: timestampColumn("created_at").notNull(),
  updatedAt: timestampColumn("updated_at").notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuidColumn("id").primaryKey(),
    userId: uuidColumn("user_id").notNull(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    providerUserUnique: uniqueIndex("auth_identities_provider_user_unique").on(
      table.provider,
      table.providerUserId,
    ),
    userIndex: index("idx_auth_identities_user").on(table.userId),
  }),
);

export const organizations = pgTable("organizations", {
  id: uuidColumn("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdByUserId: uuidColumn("created_by_user_id").notNull(),
  githubJoinPolicy: text("github_join_policy").notNull().default("request_approve"),
  githubVerifiedDomains: text("github_verified_domains")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestampColumn("created_at").notNull(),
  updatedAt: timestampColumn("updated_at").notNull(),
}, (table) => ({
  slugUnique: uniqueIndex("organizations_slug_unique").on(table.slug),
}));

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    organizationId: uuidColumn("organization_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    joinedAt: timestampColumn("joined_at").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.userId] }),
    userIndex: index("idx_memberships_user").on(table.userId),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    defaultRuntime: jsonb("default_runtime").$type<{ id: string; config?: unknown }>(),
    // The relay workspace (rw_xxxxxxxx) bound to this app workspace. Populated
    // lazily on first workflow run by resolveOrProvisionRelayWorkspace. Nullable
    // so existing rows don't need a backfill and new rows don't need a row-lock
    // at creation time — the run-time resolver provisions + binds idempotently.
    relayWorkspaceId: text("relay_workspace_id"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    orgSlugUnique: uniqueIndex("workspaces_org_slug_unique").on(table.organizationId, table.slug),
    orgIndex: index("idx_workspaces_org").on(table.organizationId),
    relayWorkspaceIdIndex: index("idx_workspaces_relay_workspace_id").on(table.relayWorkspaceId),
  }),
);

export const workers = pgTable(
  "workers",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    hostInfo: jsonb("host_info")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    lastSeen: timestampColumn("last_seen"),
    registeredAt: timestampColumn("registered_at").notNull().defaultNow(),
    registeredBy: uuidColumn("registered_by").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
  },
  (table) => ({
    workspaceNameUnique: uniqueIndex("workers_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
    workspaceIndex: index("workers_workspace").on(table.workspaceId),
    statusIndex: index("workers_status")
      .on(table.status)
      .where(sql`${table.status} != 'revoked'`),
  }),
);

export const workerEnrollmentTokens = pgTable(
  "worker_enrollment_tokens",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuidColumn("created_by").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    usedAt: timestampColumn("used_at"),
    usedFromIp: inet("used_from_ip"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("worker_enrollment_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
  }),
);

export const nodeEnrollmentTokens = pgTable(
  "node_enrollment_tokens",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    relayWorkspaceId: text("relay_workspace_id").notNull(),
    requestedName: text("requested_name"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    maxAgents: integer("max_agents").notNull().default(0),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdBy: uuidColumn("created_by").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    claimNonce: text("claim_nonce"),
    claimedAt: timestampColumn("claimed_at"),
    usedAt: timestampColumn("used_at"),
    usedFromIp: inet("used_from_ip"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("node_enrollment_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
    workspaceIndex: index("idx_node_enrollment_tokens_workspace").on(table.workspaceId),
    expiresAtIndex: index("idx_node_enrollment_tokens_expires_at").on(table.expiresAt),
  }),
);

export const relayWorkspaces = pgTable(
  "relay_workspaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: uuidColumn("owner_user_id").notNull(),
    name: text("name").notNull(),
    relaycastApiKey: text("relaycast_api_key").notNull().default(""),
    permissionsJson: text("permissions_json").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    ownerIndex: index("idx_relay_workspaces_owner").on(table.ownerUserId),
  }),
);

export const apiTokenSessions = pgTable(
  "api_token_sessions",
  {
    id: uuidColumn("id").primaryKey(),
    tokenFamilyId: uuidColumn("token_family_id").notNull(),
    subjectType: text("subject_type").notNull(),
    userId: uuidColumn("user_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    sandboxId: text("sandbox_id"),
    runId: uuidColumn("run_id"),
    scopes: text("scopes").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    accessTokenExpiresAt: timestampColumn("access_token_expires_at").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    refreshTokenExpiresAt: timestampColumn("refresh_token_expires_at").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    lastUsedAt: timestampColumn("last_used_at"),
    lastRefreshedAt: timestampColumn("last_refreshed_at"),
    revokedAt: timestampColumn("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    accessTokenHashUnique: uniqueIndex("api_token_sessions_access_hash_unique").on(
      table.accessTokenHash,
    ),
    refreshTokenHashUnique: uniqueIndex("api_token_sessions_refresh_hash_unique").on(
      table.refreshTokenHash,
    ),
    tokenFamilyIndex: index("idx_api_token_sessions_family").on(table.tokenFamilyId),
    userIndex: index("idx_api_token_sessions_user").on(table.userId),
    runIndex: index("idx_api_token_sessions_run").on(table.runId),
    sandboxIndex: index("idx_api_token_sessions_sandbox").on(table.sandboxId),
  }),
);

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    harness: text("harness").notNull(),
    modelProvider: text("model_provider").notNull().default(""),
    // Allowed values enforced by provider_credentials_auth_type_check:
    // 'provider_oauth' | 'byo_api_key' | 'relay_managed' | 'oauth_token'
    authType: text("auth_type").notNull().default("provider_oauth"),
    label: text("label"),
    keyFingerprint: text("key_fingerprint"),
    displayName: text("display_name").notNull(),
    defaultModel: text("default_model"),
    // Provider-account email parsed from the stored OAuth payload at
    // auth-complete time (null for API-key credentials or pre-feature rows
    // until the next re-auth).
    accountEmail: text("account_email"),
    // Exactly one active credential per (user, workspace, model_provider) —
    // enforced by the provider_credentials_one_active_per_provider partial
    // unique index.
    isActive: boolean("is_active").notNull().default(false),
    status: text("status").notNull(),
    credentialStoredAt: timestampColumn("credential_stored_at"),
    lastAuthenticatedAt: timestampColumn("last_authenticated_at"),
    credentialExpiresAt: timestampColumn("credential_expires_at"),
    refreshAttempts: integer("refresh_attempts").notNull().default(0),
    refreshExhausted: boolean("refresh_exhausted").notNull().default(false),
    lastRefreshAttemptAt: timestampColumn("last_refresh_attempt_at"),
    lastUsedAt: timestampColumn("last_used_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    workspaceUserIndex: index("idx_provider_credentials_workspace_user").on(table.workspaceId, table.userId),
    uniquePerWorkspaceKey: uniqueIndex("provider_credentials_unique_per_workspace_key").on(
      table.userId,
      table.workspaceId,
      table.modelProvider,
      table.authType,
      sql`COALESCE(${table.label}, '')`,
      sql`COALESCE(${table.keyFingerprint}, '')`,
    ),
  }),
);

export const providerCredentialAuthSessions = pgTable(
  "provider_credential_auth_sessions",
  {
    id: uuidColumn("id").primaryKey(),
    providerCredentialId: uuidColumn("provider_credential_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    harness: text("harness").notNull(),
    status: text("status").notNull(),
    language: text("language").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    remoteCommand: text("remote_command"),
    startedAt: timestampColumn("started_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    completedAt: timestampColumn("completed_at"),
    failedAt: timestampColumn("failed_at"),
    canceledAt: timestampColumn("canceled_at"),
    credentialStoredAt: timestampColumn("credential_stored_at"),
    failureReason: text("failure_reason"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    credentialIndex: index("idx_provider_credential_auth_sessions_credential").on(table.providerCredentialId),
    userStatusIndex: index("idx_provider_credential_auth_sessions_user_status").on(table.userId, table.status),
    expiresAtIndex: index("idx_provider_credential_auth_sessions_expires_at").on(table.expiresAt),
    sandboxUnique: uniqueIndex("provider_credential_auth_sessions_sandbox_unique").on(table.sandboxId),
  }),
);

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

export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    token: text("token").notNull(),
    invitedByUserId: uuidColumn("invited_by_user_id").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    acceptedAt: timestampColumn("accepted_at"),
    canceledAt: timestampColumn("canceled_at"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("organization_invites_token_unique").on(table.token),
    orgIndex: index("idx_organization_invites_org").on(table.organizationId),
    emailIndex: index("idx_organization_invites_email").on(table.email),
  }),
);

/**
 * Cloud-agent box warm jobs (issue #1384).
 *
 * Durable record of an async box-warm "attempt", so the warm sequence can be
 * driven across queue-backed chunked continuations (slice 3+) instead of one
 * long background task. `currentStep` is the checkpoint of the last completed
 * warm step; `status`/`leaseUntil`/`attemptCount` implement single-flight
 * claim-with-lease. DORMANT in slice 2 — defined and migrated, but the live
 * warm path still runs via scheduleBackgroundTask/waitUntil and does not write
 * here yet.
 */
export type CloudAgentBoxWarmJobRequest = {
  mountPaths?: string[];
  workspaceSource?: Record<string, unknown> | null;
  workspaceToken?: string | null;
  /** Explicit relay workspace key the in-sandbox broker should join (#125). */
  workspaceKey?: string;
  /** Stable broker instance name pear assigned this sandbox's broker (#125). */
  brokerName?: string;
};

export const cloudAgentBoxWarmJobs = pgTable(
  "cloud_agent_box_warm_jobs",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    cloudAgentId: uuidColumn("cloud_agent_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    /** Daytona sandbox id once ensure-sandbox has created/adopted it. */
    sandboxId: text("sandbox_id"),
    status: text("status").notNull().default("queued"), // queued | running | ready | failed
    /** Last completed warm step (checkpoint); null before the first step. */
    currentStep: text("current_step"),
    /**
     * Original warm request params (mountPaths/workspaceSource/workspaceToken)
     * captured at enqueue, so the queue consumer rebuilds the warm context from
     * the DB row each step (issue #1384 slice 3, #1445 rule). No secrets.
     */
    request: jsonb("request").$type<CloudAgentBoxWarmJobRequest>(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseUntil: timestampColumn("lease_until"),
    lastError: text("last_error"),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspaceCloudAgentIndex: index(
      "idx_cloud_agent_box_warm_jobs_workspace_cloud_agent",
    ).on(table.workspaceId, table.cloudAgentId),
    statusLeaseIndex: index("idx_cloud_agent_box_warm_jobs_status_lease").on(
      table.status,
      table.leaseUntil,
    ),
  }),
);

/**
 * Per-PR warm sandbox leases (cloud#1449, Phase A).
 *
 * Mirrors the durable warm-job contract shape from `cloud_agent_box_warm_jobs`
 * (`state`/`leaseUntil`/`attemptCount`/`currentStep`) so a later queue-backed
 * cutover can reuse the same claim/checkpoint semantics. Phase A writes warm
 * leases only; release, eviction, idle-stop, and reaping are Phase B.
 */
export const prSandboxLeases = pgTable(
  "pr_sandbox_leases",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    agentId: uuidColumn("agent_id").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    sandboxId: text("sandbox_id"),
    sandboxName: text("sandbox_name").notNull(),
    state: text("state").notNull().default("warm"), // warm | idle | released | evicted
    leaseUntil: timestampColumn("lease_until"),
    lastUsedAt: timestampColumn("last_used_at").notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    currentStep: text("current_step"),
    // Daytona snapshot identity (e.g. relay-orchestrator-sdk-…-relayfile-v0.8.5-…)
    // this lease's box was provisioned from. Warm reuse is gated on a strict
    // match against the current getSnapshotName(), so a RELAYFILE_MOUNT_VERSION
    // bump auto-invalidates stale boxes instead of silently reusing an old binary.
    snapshotVersion: text("snapshot_version"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    prLeaseUnique: uniqueIndex("pr_sandbox_leases_workspace_agent_repo_pr_unique").on(
      table.workspaceId,
      table.agentId,
      table.repoFullName,
      table.prNumber,
    ),
    stateLastUsedIndex: index("idx_pr_sandbox_leases_state_last_used").on(
      table.state,
      table.lastUsedAt,
    ),
    stateLeaseIndex: index("idx_pr_sandbox_leases_state_lease").on(
      table.state,
      table.leaseUntil,
    ),
  }),
);

/**
 * Warm sandbox leases scoped to one conversational deployment thread.
 *
 * The persistent harnessSessionId is intentionally separate from Daytona's
 * command session id; it is the id the in-sandbox harness can use to resume
 * model context across Slack replies in the same thread.
 */
export const conversationSandboxLeases = pgTable(
  "conversation_sandbox_leases",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    deploymentId: text("deployment_id").notNull(),
    agentId: text("agent_id").notNull(),
    conversationKey: text("conversation_key").notNull(),
    harnessSessionId: text("harness_session_id").notNull(),
    sandboxId: text("sandbox_id"),
    sandboxName: text("sandbox_name").notNull(),
    state: text("state").notNull().default("warm"), // warming | in_use | warm | idle | released | evicted
    leaseUntil: timestampColumn("lease_until"),
    lastUsedAt: timestampColumn("last_used_at").notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    currentStep: text("current_step"),
    snapshotVersion: text("snapshot_version"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    conversationLeaseUnique: uniqueIndex("conversation_sandbox_leases_workspace_agent_conversation_unique").on(
      table.workspaceId,
      table.agentId,
      table.conversationKey,
    ),
    stateLastUsedIndex: index("idx_conversation_sandbox_leases_state_last_used").on(
      table.state,
      table.lastUsedAt,
    ),
    stateLeaseIndex: index("idx_conversation_sandbox_leases_state_lease").on(
      table.state,
      table.leaseUntil,
    ),
    workspaceStateIndex: index("idx_conversation_sandbox_leases_workspace_state").on(
      table.workspaceId,
      table.state,
    ),
  }),
);

export const sandboxes = pgTable(
  "sandboxes",
  {
    id: text("id").primaryKey(), // Daytona sandbox ID
    userId: uuidColumn("user_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    /** What created this sandbox: "workflow", "pear", "cli", etc. */
    source: text("source").notNull(),
    /** Optional workflow run that created this sandbox */
    runId: uuidColumn("run_id"),
    /** Optional provider credential powering a sticky cloud-agent box. */
    cloudAgentId: uuidColumn("cloud_agent_id"),
    status: text("status").notNull(), // "running" | "stopped" | "archived" | "deleted"
    brokerPort: integer("broker_port"),
    error: text("error"),
    expectedReadyBy: timestampColumn("expected_ready_by"),
    keepaliveUntil: timestampColumn("keepalive_until"),
    /**
     * Pointer to the in-flight warm job for this sticky cloud-agent box
     * (issue #1384, slice 2). Nullable; set null when the job row is removed.
     * DORMANT — not yet written by the live warm path.
     */
    activeWarmJobId: uuidColumn("active_warm_job_id").references(
      () => cloudAgentBoxWarmJobs.id,
      { onDelete: "set null" },
    ),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    userIndex: index("idx_sandboxes_user").on(table.userId),
    workspaceCloudAgentIndex: index("idx_sandboxes_workspace_cloud_agent").on(
      table.workspaceId,
      table.cloudAgentId,
      table.status,
    ),
    cloudAgentKeepaliveIndex: index("idx_sandboxes_cloud_agent_keepalive")
      .on(table.keepaliveUntil)
      .where(sql`${table.source} = 'cloud-agent' AND ${table.cloudAgentId} IS NOT NULL AND ${table.status} = 'running' AND ${table.keepaliveUntil} IS NOT NULL`),
  }),
);

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    email: text("email").primaryKey(),
    emailStatus: text("email_status").notNull().default("unconfirmed"),
    source: text("source"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    emailStatusIndex: index("idx_waitlist_entries_email_status").on(table.emailStatus),
    createdAtIndex: index("idx_waitlist_entries_created_at").on(table.createdAt),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuidColumn("id").primaryKey(),
    sandboxId: text("sandbox_id"),
    dispatchType: text("dispatch_type").notNull().default("sandbox"),
    userId: uuidColumn("user_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    relayWorkspaceId: text("relay_workspace_id"),
    workflow: text("workflow").notNull(),
    fileType: text("file_type").notNull(),
    callbackToken: text("callback_token").notNull(),
    status: text("status").notNull(),
    relayauthIdentityId: text("relayauth_identity_id"),
    result: text("result"),
    error: text("error"),
    paths: jsonb("paths").$type<Array<{
      name: string;
      s3CodeKey: string;
      repoOwner?: string;
      repoName?: string;
    }>>(),
    pushedTo: jsonb("pushed_to").$type<Record<string, unknown>>(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    userIndex: index("idx_workflow_runs_user").on(table.userId),
    workspaceIndex: index("idx_workflow_runs_workspace").on(table.workspaceId),
    statusIndex: index("idx_workflow_runs_status").on(table.status),
  }),
);

export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: uuidColumn("id").primaryKey(),
    relaycronScheduleId: text("relaycron_schedule_id").notNull(),
    relaycronApiKeyEnvelope: jsonb("relaycron_api_key_envelope").$type<EncryptedEnvelopeJson>().notNull(),
    userId: uuidColumn("user_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    scheduleType: text("schedule_type").notNull(),
    cronExpression: text("cron_expression"),
    scheduledAt: timestampColumn("scheduled_at"),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("active"),
    workflowRequestEnvelope: jsonb("workflow_request_envelope").$type<EncryptedEnvelopeJson>().notNull(),
    webhookSecretHash: text("webhook_secret_hash").notNull(),
    lastTriggeredRunId: uuidColumn("last_triggered_run_id"),
    lastTriggeredAt: timestampColumn("last_triggered_at"),
    lastTriggerStatus: text("last_trigger_status"),
    lastTriggerError: text("last_trigger_error"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    relaycronScheduleUnique: uniqueIndex("workflow_schedules_relaycron_schedule_unique").on(
      table.relaycronScheduleId,
    ),
    userIndex: index("idx_workflow_schedules_user").on(table.userId),
    workspaceIndex: index("idx_workflow_schedules_workspace").on(table.workspaceId),
    organizationIndex: index("idx_workflow_schedules_organization").on(table.organizationId),
    statusIndex: index("idx_workflow_schedules_status").on(table.status),
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
    id: uuidColumn("id").primaryKey(),
    personaId: uuidColumn("persona_id").notNull(),
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    personaVersionUnique: uniqueIndex("persona_versions_persona_version_unique").on(
      table.personaId,
      table.version,
    ),
    personaHashUnique: uniqueIndex("persona_versions_persona_hash_unique").on(
      table.personaId,
      table.specHash,
    ),
    personaIndex: index("idx_persona_versions_persona").on(table.personaId),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: uuidColumn("id").primaryKey(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    personaId: uuidColumn("persona_id").notNull(),
    deployedName: text("deployed_name").notNull(),
    imageUrl: text("image_url"),
    deployedByUserId: uuidColumn("deployed_by_user_id").notNull(),
    credentialSelections: jsonb("credential_selections")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    inputValues: jsonb("input_values").$type<Record<string, string>>().notNull().default({}),
    pinnedVersionId: uuidColumn("pinned_version_id").notNull(),
    specHashAtDeploy: text("spec_hash_at_deploy").notNull(),
    status: text("status").notNull().default("active"),
    spawnedByAgentId: uuidColumn("spawned_by_agent_id"),
    watchGlobs: text("watch_globs").array().notNull().default(sql`ARRAY[]::text[]`),
    watchRules: jsonb("watch_rules").$type<unknown[]>(),
    deliveryMaxConcurrency: integer("delivery_max_concurrency"),
    deliveryMaxConcurrencyByTrigger: jsonb("delivery_max_concurrency_by_trigger")
      .$type<Record<string, number> | null>(),
    scheduleIds: text("schedule_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    scheduleWebhookSecretHash: text("schedule_webhook_secret_hash"),
    lastUsedAt: timestampColumn("last_used_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspacePersonaActiveIndex: index("idx_agents_workspace_persona_active")
      .on(table.workspaceId, table.personaId)
      .where(sql`${table.status} != 'destroyed'`),
    workspaceStatusIndex: index("idx_agents_workspace_status").on(table.workspaceId, table.status),
    pinnedVersionIndex: index("idx_agents_pinned_version").on(table.pinnedVersionId),
  }),
);

export const harnessSpendEvents = pgTable(
  "harness_spend_events",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    providerCredentialId: uuidColumn("provider_credential_id")
      .notNull()
      .references(() => providerCredentials.id, { onDelete: "cascade" }),
    occurredAt: timestampColumn("occurred_at").notNull().defaultNow(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsdMicros: bigint("cost_usd_micros", { mode: "bigint" }).notNull().default(0n),
    markupUsdMicros: bigint("markup_usd_micros", { mode: "bigint" }).notNull().default(0n),
    userId: uuidColumn("user_id").notNull(),
    agentId: uuidColumn("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuidColumn("run_id"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => ({
    credentialTimeIndex: index("idx_harness_spend_events_credential_time").on(
      table.providerCredentialId,
      table.occurredAt.desc(),
    ),
    userTimeIndex: index("idx_harness_spend_events_user_time").on(
      table.userId,
      table.occurredAt.desc(),
    ),
  }),
);

export const agentDeployments = pgTable(
  "agent_deployments",
  {
    id: uuidColumn("id").primaryKey(),
    agentId: uuidColumn("agent_id").notNull(),
    triggerKind: text("trigger_kind").notNull(),
    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestampColumn("started_at").notNull(),
    lastActiveAt: timestampColumn("last_active_at").notNull(),
    completedAt: timestampColumn("completed_at"),
    status: text("status").notNull().default("running"),
    specHashAtRun: text("spec_hash_at_run").notNull(),
    timedOutAt: timestampColumn("timed_out_at"),
    compactionSummary: text("compaction_summary"),
    parentDeploymentId: uuidColumn("parent_deployment_id"),
  },
  (table) => ({
    agentIndex: index("idx_agent_deployments_agent").on(table.agentId),
    statusIndex: index("idx_agent_deployments_status").on(table.status),
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
    // Byte-exact gateway envelope JSON piped to runner.mjs for this run
    // (cloud#1841) — the replayable `workforce invoke --fixture` input.
    // ALL-OR-NOTHING: oversized envelopes are omitted (NULL +
    // envelopeOmitted=true), never truncated — truncated JSON replays wrong.
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

export const workAssignments = pgTable(
  "work_assignments",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: uuidColumn("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workerId: uuidColumn("worker_id").references(() => workers.id, { onDelete: "set null" }),
    runId: uuidColumn("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    workflowRef: jsonb("workflow_ref").notNull(),
    status: text("status").notNull().default("queued"),
    queuedAt: timestampColumn("queued_at").notNull().defaultNow(),
    assignedAt: timestampColumn("assigned_at"),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at"),
    queueDeadline: timestampColumn("queue_deadline").notNull(),
    result: jsonb("result"),
    error: text("error"),
  },
  (table) => ({
    runIdUnique: uniqueIndex("work_assignments_run_id_unique").on(table.runId),
    workerIndex: index("work_assignments_worker")
      .on(table.workerId)
      .where(sql`${table.status} IN ('assigned', 'running')`),
    queuedIndex: index("work_assignments_queued")
      .on(table.workspaceId, table.status)
      .where(sql`${table.status} = 'queued'`),
  }),
);

export const workspaceIntegrations = pgTable(
  "workspace_integrations",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    // text (not uuid) because the productized cloud-mount registry
    // generates `rw_<8hex>` IDs (see packages/core/src/workspace/id.ts);
    // the legacy uuid type rejected those with pg `22P02 invalid input
    // syntax for type uuid`, breaking every setup-wizard user. Other
    // workspace_id columns in this schema still accept only uuid and
    // need a follow-up unification pass.
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    adapter: text("adapter").notNull().default("nango"),
    name: text("name"),
    displayName: text("display_name"),
    createdByUserId: uuidColumn("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectionId: text("connection_id"),
    providerConfigKey: text("provider_config_key"),
    installationId: text("installation_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    writebackDispatchVia: text("writeback_dispatch_via").notNull().default("bridge"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspaceProviderDefaultUnique: uniqueIndex(
      "workspace_integrations_workspace_provider_default_unique",
    )
      .on(table.workspaceId, table.provider)
      .where(sql`${table.name} IS NULL`),
    workspaceProviderNameUnique: uniqueIndex("workspace_integrations_workspace_provider_name_unique")
      .on(table.workspaceId, table.provider, table.name)
      .where(sql`${table.name} IS NOT NULL`),
    providerConnectionUnique: uniqueIndex("workspace_integrations_provider_connection_unique")
      .on(table.provider, table.connectionId)
      .where(sql`${table.provider} <> 'github'`),
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

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    installationId: text("installation_id").notNull(),
    accountType: text("account_type").notNull().default("unknown"),
    accountLogin: text("account_login"),
    accountId: text("account_id"),
    repositorySelection: text("repository_selection").notNull().default("unknown"),
    permissionsJson: jsonb("permissions_json").$type<Record<string, string>>().notNull().default({}),
    events: text("events").array().notNull().default(sql`ARRAY[]::text[]`),
    suspended: boolean("suspended").notNull().default(false),
    suspendedAt: timestampColumn("suspended_at"),
    suspendedBy: text("suspended_by"),
    installedByUserId: uuidColumn("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    providerConfigKey: text("provider_config_key"),
    connectionId: text("connection_id"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    installationUnique: uniqueIndex("github_installations_installation_id_unique").on(
      table.installationId,
    ),
    accountIndex: index("idx_github_installations_account").on(
      table.accountLogin,
      table.accountId,
    ),
  }),
);

export const workspaceGithubInstallationLinks = pgTable(
  "workspace_github_installation_links",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    // Matches workspace_integrations.workspace_id. Productized workspaces can
    // be rw_<8hex>, so this intentionally does not FK to workspaces.id yet.
    workspaceId: text("workspace_id").notNull(),
    installationId: text("installation_id")
      .notNull()
      .references(() => githubInstallations.installationId, { onDelete: "cascade" }),
    linkedByUserId: uuidColumn("linked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workspaceIntegrationId: uuidColumn("workspace_integration_id").references(
      () => workspaceIntegrations.id,
      { onDelete: "set null" },
    ),
    connectionId: text("connection_id"),
    providerConfigKey: text("provider_config_key"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspaceInstallationUnique: uniqueIndex(
      "workspace_github_installation_links_workspace_installation_unique",
    ).on(table.workspaceId, table.installationId),
    workspaceIndex: index("idx_workspace_github_installation_links_workspace").on(
      table.workspaceId,
    ),
    installationIndex: index("idx_workspace_github_installation_links_installation").on(
      table.installationId,
    ),
  }),
);

export const organizationGithubInstallations = pgTable(
  "organization_github_installations",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    organizationId: uuidColumn("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => githubInstallations.installationId, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(true),
    linkedByUserId: uuidColumn("linked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    orgInstallationUnique: uniqueIndex(
      "organization_github_installations_org_installation_unique",
    ).on(table.organizationId, table.installationId),
    orgPrimaryUnique: uniqueIndex("organization_github_installations_org_primary_unique")
      .on(table.organizationId)
      .where(sql`${table.isPrimary}`),
    installationIndex: index("idx_organization_github_installations_installation").on(
      table.installationId,
    ),
  }),
);

export const organizationJoinRequests = pgTable(
  "organization_join_requests",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    organizationId: uuidColumn("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuidColumn("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("github_org"),
    githubAccountLogin: text("github_account_login"),
    status: text("status").notNull().default("pending"),
    decidedByUserId: uuidColumn("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    openRequestUnique: uniqueIndex("organization_join_requests_open_unique")
      .on(table.organizationId, table.userId)
      .where(sql`${table.status} = 'pending'`),
    userIndex: index("idx_organization_join_requests_user").on(table.userId),
  }),
);

export const repoGithubInstallationIndex = pgTable(
  "repo_github_installation_index",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    // Matches workspace_integrations.workspace_id; see link table comment.
    workspaceId: text("workspace_id").notNull(),
    installationId: text("installation_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoId: text("repo_id"),
    accessState: text("access_state").notNull().default("active"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    workspaceRepoUnique: uniqueIndex("repo_github_installation_index_workspace_repo_unique").on(
      table.workspaceId,
      table.repoOwner,
      table.repoName,
    ),
    workspaceIndex: index("idx_repo_github_installation_index_workspace").on(
      table.workspaceId,
    ),
    workspaceInstallationIndex: index("idx_repo_github_installation_index_installation").on(
      table.workspaceId,
      table.installationId,
    ),
    accessStateIndex: index("idx_repo_github_installation_index_access_state").on(
      table.workspaceId,
      table.accessState,
    ),
  }),
);

export const workspaceIntegrationDisconnects = pgTable(
  "workspace_integration_disconnects",
  {
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    connectionId: text("connection_id").notNull(),
    providerConfigKey: text("provider_config_key"),
    disconnectedAt: timestampColumn("disconnected_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.provider, table.connectionId] }),
    workspaceProviderIndex: index("idx_workspace_integration_disconnects_workspace_provider").on(
      table.workspaceId,
      table.provider,
    ),
    expiresAtIndex: index("idx_workspace_integration_disconnects_expires_at").on(table.expiresAt),
  }),
);

export const githubCloneJobs = pgTable(
  "github_clone_jobs",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    ref: text("ref").notNull(),
    connectionId: text("connection_id").notNull(),
    // mode = 'full' | 'incremental'.
    // - 'full': existing tarball-based clone pipeline (initial clone or
    //   30-day staleness fallback).
    // - 'incremental': webhook-driven git-pull semantics over the changed
    //   files only. baseSha carries the prior head; if compareGithubRefs
    //   reports diverged/truncated, the executor falls back to a full
    //   clone but the job row stays mode='incremental' and the manifest
    //   per-job record gets fellBackToFull=true.
    mode: varchar("mode", { length: 16 }).notNull().default("full"),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    filesWritten: integer("files_written"),
    headSha: text("head_sha"),
    // baseSha is set when mode='incremental' (the prior head we compare
    // from); NULL otherwise.
    baseSha: varchar("base_sha", { length: 40 }),
    durationMs: integer("duration_ms"),
    materializationJson: jsonb("materialization_json").$type<Record<string, unknown> | null>(),
    lastError: text("last_error"),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    dedupeIndex: index("github_clone_jobs_dedupe_idx")
      .on(
        table.workspaceId,
        table.owner,
        table.repo,
        table.ref,
        table.status,
        table.createdAt,
      )
      .where(sql`${table.status} IN ('queued', 'running')`),
  }),
);

export const workflowLaunchJobs = pgTable(
  "workflow_launch_jobs",
  {
    id: uuidColumn("id").defaultRandom().primaryKey(),
    runId: uuidColumn("run_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    organizationId: uuidColumn("organization_id").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestampColumn("lease_until"),
    sandboxId: text("sandbox_id"),
    relayWorkspaceId: text("relay_workspace_id"),
    requestEnvelope: jsonb("request_envelope").$type<EncryptedEnvelopeJson>().notNull(),
    lastError: text("last_error"),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    runUnique: uniqueIndex("workflow_launch_jobs_run_unique").on(table.runId),
    statusLeaseIndex: index("idx_workflow_launch_jobs_status_lease").on(
      table.status,
      table.leaseUntil,
    ),
    workspaceIndex: index("idx_workflow_launch_jobs_workspace").on(table.workspaceId),
  }),
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuidColumn("id").primaryKey(),
    runId: uuidColumn("run_id").notNull(),
    stepName: text("step_name").notNull(),
    agent: text("agent").notNull(),
    preset: text("preset").notNull(),
    cli: text("cli").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    durationMs: integer("duration_ms").notNull(),
    exitCode: integer("exit_code").notNull(),
    outputSummary: text("output_summary").notNull(),
    error: text("error"),
  },
  (table) => ({
    runIndex: index("idx_workflow_steps_run").on(table.runId),
  }),
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: uuidColumn("id").primaryKey(),
    runId: uuidColumn("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    stepName: text("step_name"),
    sandboxId: text("sandbox_id"),
    payload: text("payload").notNull().default("{}"),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => ({
    runSequenceUnique: uniqueIndex("session_events_run_sequence_unique").on(table.runId, table.sequence),
    runIndex: index("idx_session_events_run").on(table.runId),
    eventTypeIndex: index("idx_session_events_type").on(table.eventType),
    createdAtIndex: index("idx_session_events_created_at").on(table.createdAt),
  }),
);

export const rickyRuns = pgTable(
  "ricky_runs",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    rootWorkflowRunId: uuidColumn("root_workflow_run_id").notNull(),
    activeWorkflowRunId: uuidColumn("active_workflow_run_id"),
    status: text("status").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    currentAttempt: integer("current_attempt").notNull(),
    sourceWorkflowPath: text("source_workflow_path"),
    sourceFileType: text("source_file_type").notNull(),
    runtimeJson: jsonb("runtime_json").$type<Record<string, unknown>>(),
    autoFixPolicyJson: jsonb("auto_fix_policy_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    selectedAgentJson: jsonb("selected_agent_json").$type<Record<string, unknown>>(),
    latestDiagnosisJson: jsonb("latest_diagnosis_json").$type<Record<string, unknown>>(),
    finalResultJson: jsonb("final_result_json").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => ({
    workspaceIndex: index("idx_ricky_runs_workspace").on(table.workspaceId),
    userIndex: index("idx_ricky_runs_user").on(table.userId),
    rootWorkflowRunIndex: index("idx_ricky_runs_root_workflow_run").on(table.rootWorkflowRunId),
    activeWorkflowRunIndex: index("idx_ricky_runs_active_workflow_run").on(table.activeWorkflowRunId),
    statusIndex: index("idx_ricky_runs_status").on(table.status),
  }),
);

export const rickyAttempts = pgTable(
  "ricky_attempts",
  {
    id: uuidColumn("id").primaryKey(),
    rickyRunId: uuidColumn("ricky_run_id").notNull(),
    attempt: integer("attempt").notNull(),
    workflowRunId: uuidColumn("workflow_run_id").notNull(),
    previousWorkflowRunId: uuidColumn("previous_workflow_run_id"),
    startFromStep: text("start_from_step"),
    role: text("role").notNull(),
    repairMode: text("repair_mode"),
    repairAgentJson: jsonb("repair_agent_json").$type<Record<string, unknown>>(),
    diagnosisJson: jsonb("diagnosis_json").$type<Record<string, unknown>>(),
    evidenceSnapshotJson: jsonb("evidence_snapshot_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    repairSummary: text("repair_summary"),
    repairedWorkflowPath: text("repaired_workflow_path"),
    repairedWorkflowDigest: text("repaired_workflow_digest"),
    repairedArtifactJson: jsonb("repaired_artifact_json").$type<Record<string, unknown>>(),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => ({
    rickyRunAttemptUnique: uniqueIndex("ricky_attempts_run_attempt_unique").on(
      table.rickyRunId,
      table.attempt,
    ),
    rickyRunIndex: index("idx_ricky_attempts_ricky_run").on(table.rickyRunId),
    workflowRunIndex: index("idx_ricky_attempts_workflow_run").on(table.workflowRunId),
    statusIndex: index("idx_ricky_attempts_status").on(table.status),
  }),
);

export const rickyHumanGates = pgTable(
  "ricky_human_gates",
  {
    id: uuidColumn("id").primaryKey(),
    rickyRunId: uuidColumn("ricky_run_id").notNull(),
    attemptId: uuidColumn("attempt_id").notNull(),
    workflowRunId: uuidColumn("workflow_run_id"),
    gateType: text("gate_type").notNull(),
    reason: text("reason").notNull(),
    prompt: text("prompt").notNull(),
    proposedActionJson: jsonb("proposed_action_json").$type<Record<string, unknown>>(),
    status: text("status").notNull(),
    requestedByAgentJson: jsonb("requested_by_agent_json").$type<Record<string, unknown>>(),
    resolvedByUserId: uuidColumn("resolved_by_user_id"),
    resolutionJson: jsonb("resolution_json").$type<Record<string, unknown>>(),
    expiresAt: timestampColumn("expires_at"),
    createdAt: timestampColumn("created_at").notNull(),
    resolvedAt: timestampColumn("resolved_at"),
  },
  (table) => ({
    rickyRunIndex: index("idx_ricky_human_gates_ricky_run").on(table.rickyRunId),
    attemptIndex: index("idx_ricky_human_gates_attempt").on(table.attemptId),
    statusIndex: index("idx_ricky_human_gates_status").on(table.status),
  }),
);

export const rickyRunEvents = pgTable(
  "ricky_run_events",
  {
    id: uuidColumn("id").primaryKey(),
    rickyRunId: uuidColumn("ricky_run_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => ({
    rickyRunSequenceUnique: uniqueIndex("ricky_run_events_run_sequence_unique").on(
      table.rickyRunId,
      table.sequence,
    ),
    rickyRunIndex: index("idx_ricky_run_events_ricky_run").on(table.rickyRunId),
    eventTypeIndex: index("idx_ricky_run_events_type").on(table.eventType),
    createdAtIndex: index("idx_ricky_run_events_created_at").on(table.createdAt),
  }),
);

export const rickySlackInstallations = pgTable(
  "ricky_slack_installations",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackEnterpriseId: text("slack_enterprise_id"),
    botUserId: text("bot_user_id"),
    connectionId: text("connection_id").notNull(),
    providerConfigKey: text("provider_config_key"),
    installedByUserId: uuidColumn("installed_by_user_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    workspaceIndex: index("idx_ricky_slack_installations_workspace").on(table.workspaceId),
    teamIndex: index("idx_ricky_slack_installations_team").on(table.slackTeamId),
    teamWorkspaceUnique: uniqueIndex("ricky_slack_installations_team_workspace_unique").on(
      table.slackTeamId,
      table.workspaceId,
    ),
  }),
);

export const rickySlackUserLinks = pgTable(
  "ricky_slack_user_links",
  {
    id: uuidColumn("id").primaryKey(),
    organizationId: uuidColumn("organization_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    cloudUserId: uuidColumn("cloud_user_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    cloudUserIndex: index("idx_ricky_slack_user_links_cloud_user").on(table.cloudUserId),
    slackIdentityIndex: index("idx_ricky_slack_user_links_slack_identity").on(
      table.slackTeamId,
      table.slackUserId,
    ),
    slackIdentityWorkspaceUnique: uniqueIndex("ricky_slack_user_links_identity_workspace_unique").on(
      table.slackTeamId,
      table.slackUserId,
      table.workspaceId,
    ),
  }),
);

export const rickySlackRunThreads = pgTable(
  "ricky_slack_run_threads",
  {
    id: uuidColumn("id").primaryKey(),
    rickyRunId: uuidColumn("ricky_run_id").notNull(),
    rootWorkflowRunId: uuidColumn("root_workflow_run_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    createdBySlackUserId: text("created_by_slack_user_id").notNull(),
    notifyPolicyJson: jsonb("notify_policy_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    rickyRunUnique: uniqueIndex("ricky_slack_run_threads_ricky_run_unique").on(table.rickyRunId),
    workspaceIndex: index("idx_ricky_slack_run_threads_workspace").on(table.workspaceId),
    slackThreadIndex: index("idx_ricky_slack_run_threads_slack_thread").on(
      table.slackTeamId,
      table.channelId,
      table.threadTs,
    ),
  }),
);

export const rickySlackGateMessages = pgTable(
  "ricky_slack_gate_messages",
  {
    id: uuidColumn("id").primaryKey(),
    gateId: uuidColumn("gate_id").notNull(),
    rickyRunId: uuidColumn("ricky_run_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts").notNull(),
    threadTs: text("thread_ts"),
    status: text("status").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    gateUnique: uniqueIndex("ricky_slack_gate_messages_gate_unique").on(table.gateId),
    rickyRunIndex: index("idx_ricky_slack_gate_messages_ricky_run").on(table.rickyRunId),
    slackMessageIndex: index("idx_ricky_slack_gate_messages_slack_message").on(
      table.slackTeamId,
      table.channelId,
      table.messageTs,
    ),
  }),
);

export const workflowRepositoryAllowlists = pgTable(
  "workflow_repository_allowlists",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    installationId: text("installation_id").notNull(),
    pushAllowed: boolean("push_allowed").notNull().default(false),
    allowedAt: timestamp("allowed_at", { withTimezone: true }).notNull(),
    allowedBy: uuid("allowed_by").notNull(),
  },
  (table) => ({
    workspaceRepoUnique: uniqueIndex("workflow_repository_allowlists_workspace_repo_unique").on(
      table.workspaceId,
      table.repoOwner,
      table.repoName,
    ),
    workspaceIndex: index("idx_workflow_repository_allowlists_workspace").on(table.workspaceId),
  }),
);

// Persistent revocation records for relayfile access tokens (see
// packages/core/src/relay-file-access.ts). Revocations were previously held
// in-memory only, so a process/Lambda restart silently un-revoked tokens and
// replicas never saw each other's revocations. Rows store a SHA-256 hash of
// the token (never the raw bearer token) and self-expire at the token's
// natural JWT expiry: a revocation past `expires_at` is moot because the
// token itself is no longer valid, so reads filter on it and pruning deletes
// past-expiry rows.
export const relayFileAccessRevocations = pgTable(
  "relay_file_access_revocations",
  {
    tokenHash: text("token_hash").primaryKey(),
    scope: text("scope").notNull().default("relayfile-access"),
    workspace: text("workspace"),
    agentName: text("agent_name"),
    revokedAt: timestampColumn("revoked_at").notNull().defaultNow(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => ({
    expiresAtIndex: index("idx_relay_file_access_revocations_expires_at").on(table.expiresAt),
  }),
);
