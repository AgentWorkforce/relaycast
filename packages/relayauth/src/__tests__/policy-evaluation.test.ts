import assert from "node:assert/strict";
import test from "node:test";
import type { Policy, PolicyCondition, PolicyEffect, Role } from "@relayauth/types";
import type {
  IdentityBudget,
  IdentityBudgetUsage,
  StoredIdentity,
} from "../durable-objects/identity-do.js";
import { generateTestIdentity } from "./test-helpers.js";

type StoredPolicy = Policy & {
  deletedAt?: string;
};

type EvaluationContext = {
  identityId?: string;
  ip?: string;
  timestamp?: string;
  workspaceId?: string;
};

type EvaluationResult = {
  effectiveScopes: string[];
  appliedPolicies: unknown[];
  deniedScopes: string[];
};

type AccessDecision = {
  allowed: boolean;
  reason: string;
  matchedPolicy?: string;
};

type PolicyEvaluationModule = {
  evaluatePermissions?: (
    db: D1Database,
    identityId: string,
    orgId: string,
    context?: EvaluationContext,
  ) => Promise<EvaluationResult>;
  getEffectiveScopes?: (
    db: D1Database,
    identityId: string,
    orgId: string,
    context?: EvaluationContext,
  ) => Promise<string[]>;
  checkAccess?: (
    db: D1Database,
    identityId: string,
    orgId: string,
    requestedScope: string,
    context?: EvaluationContext,
  ) => Promise<AccessDecision>;
};

type AuditWrite = {
  query: string;
  params: unknown[];
};

type PolicyEvaluationScenario = {
  db: D1Database;
  auditWrites: AuditWrite[];
};

type IdentityRow = {
  id: string;
  name: string;
  type: string;
  orgId: string;
  org_id: string;
  status: string;
  scopes: string[];
  scopes_json: string;
  roles: string[];
  roles_json: string;
  metadata: Record<string, string>;
  metadata_json: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  sponsorId: string;
  sponsor_id: string;
  sponsorChain: string[];
  sponsor_chain: string;
  sponsor_chain_json: string;
  workspaceId: string;
  workspace_id: string;
  budget: IdentityBudget | null;
  budget_json: string | null;
  budgetUsage: IdentityBudgetUsage | null;
  budget_usage: IdentityBudgetUsage | null;
  budget_usage_json: string | null;
};

type RoleRow = {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  scopes_json: string;
  orgId: string;
  org_id: string;
  workspaceId?: string;
  workspace_id?: string;
  builtIn: boolean;
  built_in: number;
  createdAt: string;
  created_at: string;
};

type PolicyRow = {
  id: string;
  name: string;
  effect: PolicyEffect;
  scopes: string[];
  scopes_json: string;
  conditions: PolicyCondition[];
  conditions_json: string;
  priority: number;
  orgId: string;
  org_id: string;
  workspaceId?: string;
  workspace_id?: string;
  createdAt: string;
  created_at: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity({
    ...overrides,
    id: overrides.id ?? "agent_policy_eval",
    orgId: overrides.orgId ?? "org_test",
    roles: overrides.roles ?? [],
    scopes: overrides.scopes ?? [],
    status: overrides.status ?? "active",
  });

  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: overrides.id ?? "role_policy_eval",
    name: overrides.name ?? "policy-evaluator",
    description: overrides.description ?? "Policy evaluation test role",
    scopes: overrides.scopes ?? ["relayauth:identity:read:*"],
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: overrides.id ?? "pol_policy_eval",
    name: overrides.name ?? "policy-evaluator-rule",
    effect: overrides.effect ?? "allow",
    scopes: overrides.scopes ?? ["relayfile:fs:write:/reports/*"],
    conditions: overrides.conditions ?? [],
    priority: overrides.priority ?? 500,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
  };
}

function toIdentityRow(identity: StoredIdentity): IdentityRow {
  const metadata = clone(identity.metadata ?? {});
  const budget = identity.budget ? clone(identity.budget) : null;
  const budgetUsage = identity.budgetUsage ? clone(identity.budgetUsage) : null;

  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    org_id: identity.orgId,
    status: identity.status,
    scopes: [...identity.scopes],
    scopes_json: JSON.stringify(identity.scopes),
    roles: [...identity.roles],
    roles_json: JSON.stringify(identity.roles),
    metadata,
    metadata_json: JSON.stringify(metadata),
    createdAt: identity.createdAt,
    created_at: identity.createdAt,
    updatedAt: identity.updatedAt,
    updated_at: identity.updatedAt,
    sponsorId: identity.sponsorId,
    sponsor_id: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    sponsor_chain: JSON.stringify(identity.sponsorChain),
    sponsor_chain_json: JSON.stringify(identity.sponsorChain),
    workspaceId: identity.workspaceId,
    workspace_id: identity.workspaceId,
    budget,
    budget_json: budget ? JSON.stringify(budget) : null,
    budgetUsage,
    budget_usage: budgetUsage,
    budget_usage_json: budgetUsage ? JSON.stringify(budgetUsage) : null,
  };
}

function toRoleRow(role: Role): RoleRow {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    scopes: [...role.scopes],
    scopes_json: JSON.stringify(role.scopes),
    orgId: role.orgId,
    org_id: role.orgId,
    ...(role.workspaceId !== undefined ? { workspaceId: role.workspaceId, workspace_id: role.workspaceId } : {}),
    builtIn: role.builtIn,
    built_in: role.builtIn ? 1 : 0,
    createdAt: role.createdAt,
    created_at: role.createdAt,
  };
}

function toPolicyRow(policy: StoredPolicy): PolicyRow {
  return {
    id: policy.id,
    name: policy.name,
    effect: policy.effect,
    scopes: [...policy.scopes],
    scopes_json: JSON.stringify(policy.scopes),
    conditions: policy.conditions.map((condition) => ({ ...condition })),
    conditions_json: JSON.stringify(policy.conditions),
    priority: policy.priority,
    orgId: policy.orgId,
    org_id: policy.orgId,
    ...(policy.workspaceId !== undefined
      ? { workspaceId: policy.workspaceId, workspace_id: policy.workspaceId }
      : {}),
    createdAt: policy.createdAt,
    created_at: policy.createdAt,
    ...(policy.deletedAt !== undefined
      ? { deletedAt: policy.deletedAt, deleted_at: policy.deletedAt }
      : {}),
  };
}

function extractClauseOrder<TField extends string>(
  sql: string,
  patterns: Array<{ field: TField; regexes: RegExp[] }>,
): Array<{ field: TField; index: number }> {
  return patterns
    .map((pattern) => ({
      field: pattern.field,
      index: Math.min(
        ...pattern.regexes
          .map((regex) => sql.search(regex))
          .filter((candidate) => candidate >= 0),
      ),
    }))
    .filter((candidate) => Number.isFinite(candidate.index))
    .sort((left, right) => left.index - right.index);
}

function filterIdentitiesByQuery(allIdentities: StoredIdentity[], query: string, params: unknown[]): StoredIdentity[] {
  const sql = normalizeSql(query);
  let identities = [...allIdentities];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
    { field: "status", regexes: [/\bstatus\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "sponsorId", regexes: [/\bsponsor_id\s*=\s*\?/i, /\bsponsorid\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    identities = identities.filter((identity) => identity.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    identities = identities.filter((identity) => identity.id === id);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    identities = identities.filter((identity) => identity.name === name);
  }

  const status = values.get("status");
  if (typeof status === "string") {
    identities = identities.filter((identity) => identity.status === status);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    identities = identities.filter((identity) => identity.workspaceId === workspaceId);
  }

  const sponsorId = values.get("sponsorId");
  if (typeof sponsorId === "string") {
    identities = identities.filter((identity) => identity.sponsorId === sponsorId);
  }

  return identities;
}

function filterRolesByQuery(allRoles: Role[], query: string, params: unknown[]): Role[] {
  const sql = normalizeSql(query);
  let roles = [...allRoles];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    roles = roles.filter((role) => role.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    roles = roles.filter((role) => role.id === id);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    roles = roles.filter((role) => role.name === name);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped =
      /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
      || /\bworkspace_id\s+is\s+null\s+or\s+workspace_id\s*=\s*\?\b/i.test(sql)
      || /\bworkspaceid\s*=\s*\?\s+or\s+workspaceid\s+is\s+null\b/i.test(sql)
      || /\bworkspaceid\s+is\s+null\s+or\s+workspaceid\s*=\s*\?\b/i.test(sql);

    roles = roles.filter((role) =>
      includeOrgScoped
        ? role.workspaceId === workspaceId || role.workspaceId === undefined
        : role.workspaceId === workspaceId,
    );
  } else if (/\bworkspace_id\s+is\s+null\b/i.test(sql) || /\bworkspaceid\s+is\s+null\b/i.test(sql)) {
    roles = roles.filter((role) => role.workspaceId === undefined);
  }

  if (/\border by\b.*\bname\b.*\basc\b/i.test(sql)) {
    roles.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  } else {
    roles.sort((left, right) => left.id.localeCompare(right.id));
  }

  return roles;
}

function filterPoliciesByQuery(allPolicies: StoredPolicy[], query: string, params: unknown[]): StoredPolicy[] {
  const sql = normalizeSql(query);
  let policies = [...allPolicies];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    policies = policies.filter((policy) => policy.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    policies = policies.filter((policy) => policy.id === id);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    policies = policies.filter((policy) => policy.name === name);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped =
      /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
      || /\bworkspace_id\s+is\s+null\s+or\s+workspace_id\s*=\s*\?\b/i.test(sql)
      || /\bworkspaceid\s*=\s*\?\s+or\s+workspaceid\s+is\s+null\b/i.test(sql)
      || /\bworkspaceid\s+is\s+null\s+or\s+workspaceid\s*=\s*\?\b/i.test(sql);

    policies = policies.filter((policy) =>
      includeOrgScoped
        ? policy.workspaceId === workspaceId || policy.workspaceId === undefined
        : policy.workspaceId === workspaceId,
    );
  } else if (/\bworkspace_id\s+is\s+null\b/i.test(sql) || /\bworkspaceid\s+is\s+null\b/i.test(sql)) {
    policies = policies.filter((policy) => policy.workspaceId === undefined);
  }

  if (/\bdeleted_at\s+is\s+null\b/i.test(sql) || /\bdeletedat\s+is\s+null\b/i.test(sql)) {
    policies = policies.filter((policy) => policy.deletedAt === undefined || policy.deletedAt === null);
  }

  if (/\border by\b.*\bpriority\b.*\bdesc\b/i.test(sql)) {
    policies.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  } else {
    policies.sort((left, right) => left.id.localeCompare(right.id));
  }

  return policies;
}

function createPolicyEvaluationDb(input: {
  identities: StoredIdentity[];
  roles?: Role[];
  policies?: StoredPolicy[];
}): PolicyEvaluationScenario {
  const identities = new Map(input.identities.map((identity) => [identity.id, clone(identity)]));
  const roles = new Map((input.roles ?? []).map((role) => [role.id, clone(role)]));
  const policies = new Map((input.policies ?? []).map((policy) => [policy.id, clone(policy)]));
  const auditWrites: AuditWrite[] = [];

  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    const sql = normalizeSql(query);

    if (/\bfrom identities\b/.test(sql)) {
      return filterIdentitiesByQuery([...identities.values()], query, params).map(toIdentityRow);
    }

    if (/\bfrom roles\b/.test(sql)) {
      return filterRolesByQuery([...roles.values()], query, params).map(toRoleRow);
    }

    if (/\bfrom policies\b/.test(sql)) {
      return filterPoliciesByQuery([...policies.values()], query, params).map(toPolicyRow);
    }

    return [];
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => (resolveRows(query, params)[0] as T | null) ?? null,
      run: async () => {
        const sql = normalizeSql(query);
        if (/\binsert\s+into\s+audit_logs\b/i.test(sql) || /\binsert\s+into\s+audit_events\b/i.test(sql)) {
          auditWrites.push({ query: normalizeSql(query), params });
        }

        return { success: true, meta };
      },
      raw: async <T>() => resolveRows(query, params) as T[],
      all: async <T>() => ({ results: resolveRows(query, params) as T[], success: true, meta }),
    }),
    first: async <T>() => (resolveRows(query, [])[0] as T | null) ?? null,
    run: async () => {
      const sql = normalizeSql(query);
      if (/\binsert\s+into\s+audit_logs\b/i.test(sql) || /\binsert\s+into\s+audit_events\b/i.test(sql)) {
        auditWrites.push({ query: normalizeSql(query), params: [] });
      }

      return { success: true, meta };
    },
    raw: async <T>() => resolveRows(query, []) as T[],
    all: async <T>() => ({ results: resolveRows(query, []) as T[], success: true, meta }),
  });

  const db = {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;

  return { db, auditWrites };
}

async function loadPolicyEvaluationModule(): Promise<Required<PolicyEvaluationModule>> {
  let module: PolicyEvaluationModule;

  try {
    module = await import("../engine/policy-evaluation.js") as PolicyEvaluationModule;
  } catch (error) {
    assert.fail(
      [
        "Expected ../engine/policy-evaluation.js to exist.",
        "Implement and export evaluatePermissions(), getEffectiveScopes(), and checkAccess().",
        error instanceof Error ? error.message : String(error),
      ].join(" "),
    );
  }

  assert.equal(
    typeof module.evaluatePermissions,
    "function",
    "Expected policy evaluation engine to export evaluatePermissions(db, identityId, orgId, context?)",
  );
  assert.equal(
    typeof module.getEffectiveScopes,
    "function",
    "Expected policy evaluation engine to export getEffectiveScopes(db, identityId, orgId, context?)",
  );
  assert.equal(
    typeof module.checkAccess,
    "function",
    "Expected policy evaluation engine to export checkAccess(db, identityId, orgId, requestedScope, context?)",
  );

  return module as Required<PolicyEvaluationModule>;
}

function createContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    identityId: overrides.identityId ?? "agent_policy_eval",
    workspaceId: overrides.workspaceId ?? "ws_test",
    timestamp: overrides.timestamp ?? "2026-03-25T10:00:00Z",
    ip: overrides.ip ?? "203.0.113.7",
  };
}

function sortScopes(scopes: string[]): string[] {
  return [...scopes].sort((left, right) => left.localeCompare(right));
}

function extractAppliedPolicyIds(appliedPolicies: unknown): string[] {
  if (!Array.isArray(appliedPolicies)) {
    return [];
  }

  return appliedPolicies.flatMap((policy) => {
    if (typeof policy === "string") {
      return [policy];
    }

    if (!policy || typeof policy !== "object") {
      return [];
    }

    const candidate = policy as { id?: unknown; policyId?: unknown; name?: unknown };
    if (typeof candidate.id === "string") {
      return [candidate.id];
    }

    if (typeof candidate.policyId === "string") {
      return [candidate.policyId];
    }

    if (typeof candidate.name === "string") {
      return [candidate.name];
    }

    return [];
  });
}

function assertIncludesScope(scopes: string[], expectedScope: string, message: string) {
  assert.equal(scopes.includes(expectedScope), true, message);
}

function assertExcludesScope(scopes: string[], unexpectedScope: string, message: string) {
  assert.equal(scopes.includes(unexpectedScope), false, message);
}

function assertAuditActionRecorded(auditWrites: AuditWrite[], action: string) {
  assert.equal(
    auditWrites.some(({ params }) => params.includes(action)),
    true,
    `expected an audit write for action ${action}`,
  );
}

test("evaluatePermissions merges identity direct scopes with assigned role scopes", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_merge_scopes",
    scopes: ["relayfile:fs:read:/reports/*"],
    roles: ["role_deployer"],
  });
  const role = createRole({
    id: "role_deployer",
    name: "deployer",
    scopes: ["cloud:workflow:run:prod-*"],
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], roles: [role] });

  const result = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assert.deepEqual(
    sortScopes(result.effectiveScopes),
    sortScopes(["relayfile:fs:read:/reports/*", "cloud:workflow:run:prod-*"]),
  );
  assert.deepEqual(result.deniedScopes, []);
});

test("allow policy adds scopes to the effective scope set", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_allow_policy",
    scopes: [],
    roles: [],
  });
  const policy = createPolicy({
    id: "pol_allow_reports_write",
    name: "allow-reports-write",
    effect: "allow",
    scopes: ["relayfile:fs:write:/reports/*"],
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [policy] });

  const result = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assertIncludesScope(result.effectiveScopes, "relayfile:fs:write:/reports/*", "allow policy should add scope");
  assert.equal(extractAppliedPolicyIds(result.appliedPolicies).includes(policy.id), true);
});

test("deny policy removes scopes from the effective scope set", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_deny_policy",
    scopes: ["cloud:workflow:run:prod-*"],
    roles: [],
  });
  const policy = createPolicy({
    id: "pol_deny_prod_runs",
    name: "deny-prod-runs",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-*"],
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [policy] });

  const result = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assertExcludesScope(result.effectiveScopes, "cloud:workflow:run:prod-*", "deny policy should remove granted scope");
  assert.equal(result.deniedScopes.includes("cloud:workflow:run:prod-*"), true);
});

test("higher priority policy wins over a lower priority policy covering the same scope", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_priority_policy",
    scopes: [],
    roles: [],
  });
  const allow = createPolicy({
    id: "pol_allow_high",
    name: "allow-high",
    effect: "allow",
    scopes: ["cloud:workflow:run:prod-*"],
    priority: 900,
  });
  const deny = createPolicy({
    id: "pol_deny_low",
    name: "deny-low",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-*"],
    priority: 100,
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [allow, deny] });

  const result = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assertIncludesScope(
    result.effectiveScopes,
    "cloud:workflow:run:prod-*",
    "the higher-priority allow should win over the lower-priority deny",
  );
});

test("deny policies are evaluated after allow policies at the same priority", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_same_priority_policy",
    scopes: [],
    roles: [],
  });
  const allow = createPolicy({
    id: "pol_same_priority_allow",
    name: "same-priority-allow",
    effect: "allow",
    scopes: ["relayfile:fs:write:/finance/*"],
    priority: 500,
  });
  const deny = createPolicy({
    id: "pol_same_priority_deny",
    name: "same-priority-deny",
    effect: "deny",
    scopes: ["relayfile:fs:write:/finance/*"],
    priority: 500,
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [allow, deny] });

  const result = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assertExcludesScope(
    result.effectiveScopes,
    "relayfile:fs:write:/finance/*",
    "deny at the same priority should remove the scope added by allow",
  );
  assert.equal(result.deniedScopes.includes("relayfile:fs:write:/finance/*"), true);
});

test("time-based conditions only activate policies within the configured UTC window", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_time_window",
    scopes: [],
    roles: [],
  });
  const policy = createPolicy({
    id: "pol_business_hours",
    name: "business-hours-write",
    effect: "allow",
    scopes: ["relayfile:fs:write:/reports/*"],
    conditions: [
      { type: "time", operator: "gt", value: "09:00" },
      { type: "time", operator: "lt", value: "17:00" },
    ],
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [policy] });

  const insideWindow = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({
      identityId: identity.id,
      workspaceId: identity.workspaceId,
      timestamp: "2026-03-25T10:30:00Z",
    }),
  );
  const outsideWindow = await evaluatePermissions(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({
      identityId: identity.id,
      workspaceId: identity.workspaceId,
      timestamp: "2026-03-25T18:30:00Z",
    }),
  );

  assertIncludesScope(
    insideWindow.effectiveScopes,
    "relayfile:fs:write:/reports/*",
    "policy should apply during the active time window",
  );
  assertExcludesScope(
    outsideWindow.effectiveScopes,
    "relayfile:fs:write:/reports/*",
    "policy should not apply outside the active time window",
  );
});

test("identity-based conditions restrict policies to the targeted identity", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const targetedIdentity = createStoredIdentity({
    id: "agent_targeted",
    scopes: [],
    roles: [],
  });
  const otherIdentity = createStoredIdentity({
    id: "agent_other",
    scopes: [],
    roles: [],
  });
  const policy = createPolicy({
    id: "pol_identity_specific",
    name: "identity-specific",
    effect: "allow",
    scopes: ["relayfile:fs:write:/ops/*"],
    conditions: [
      { type: "identity", operator: "eq", value: targetedIdentity.id },
    ],
  });
  const scenario = createPolicyEvaluationDb({
    identities: [targetedIdentity, otherIdentity],
    policies: [policy],
  });

  const targeted = await evaluatePermissions(
    scenario.db,
    targetedIdentity.id,
    targetedIdentity.orgId,
    createContext({ identityId: targetedIdentity.id, workspaceId: targetedIdentity.workspaceId }),
  );
  const other = await evaluatePermissions(
    scenario.db,
    otherIdentity.id,
    otherIdentity.orgId,
    createContext({ identityId: otherIdentity.id, workspaceId: otherIdentity.workspaceId }),
  );

  assertIncludesScope(
    targeted.effectiveScopes,
    "relayfile:fs:write:/ops/*",
    "policy should apply to the targeted identity",
  );
  assertExcludesScope(
    other.effectiveScopes,
    "relayfile:fs:write:/ops/*",
    "policy should not apply to non-target identities",
  );
});

test("workspace-level policy overrides the org-level policy for the targeted workspace", async () => {
  const { evaluatePermissions } = await loadPolicyEvaluationModule();
  const prodIdentity = createStoredIdentity({
    id: "agent_ws_prod",
    workspaceId: "ws_prod",
    scopes: [],
    roles: [],
  });
  const devIdentity = createStoredIdentity({
    id: "agent_ws_dev",
    workspaceId: "ws_dev",
    scopes: [],
    roles: [],
  });
  const orgAllow = createPolicy({
    id: "pol_org_allow",
    name: "org-allow",
    effect: "allow",
    scopes: ["cloud:workflow:run:deploy-*"],
  });
  const prodDeny = createPolicy({
    id: "pol_ws_prod_deny",
    name: "ws-prod-deny",
    effect: "deny",
    scopes: ["cloud:workflow:run:deploy-*"],
    workspaceId: "ws_prod",
    priority: 700,
  });
  const scenario = createPolicyEvaluationDb({
    identities: [prodIdentity, devIdentity],
    policies: [orgAllow, prodDeny],
  });

  const prod = await evaluatePermissions(
    scenario.db,
    prodIdentity.id,
    prodIdentity.orgId,
    createContext({ identityId: prodIdentity.id, workspaceId: prodIdentity.workspaceId }),
  );
  const dev = await evaluatePermissions(
    scenario.db,
    devIdentity.id,
    devIdentity.orgId,
    createContext({ identityId: devIdentity.id, workspaceId: devIdentity.workspaceId }),
  );

  assertExcludesScope(
    prod.effectiveScopes,
    "cloud:workflow:run:deploy-*",
    "workspace deny should override the org-level policy in ws_prod",
  );
  assertIncludesScope(
    dev.effectiveScopes,
    "cloud:workflow:run:deploy-*",
    "org-level policy should still apply in other workspaces",
  );
});

test("getEffectiveScopes returns the final merged scope list after policy evaluation", async () => {
  const { getEffectiveScopes } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_effective_scopes",
    scopes: ["relayfile:fs:read:/reports/*"],
    roles: ["role_ops"],
  });
  const role = createRole({
    id: "role_ops",
    name: "ops",
    scopes: ["cloud:workflow:run:prod-*"],
  });
  const allow = createPolicy({
    id: "pol_allow_logs",
    name: "allow-logs",
    effect: "allow",
    scopes: ["relayfile:fs:read:/logs/*"],
  });
  const deny = createPolicy({
    id: "pol_deny_prod_runs",
    name: "deny-prod-runs-final",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-*"],
    priority: 800,
  });
  const scenario = createPolicyEvaluationDb({
    identities: [identity],
    roles: [role],
    policies: [allow, deny],
  });

  const scopes = await getEffectiveScopes(
    scenario.db,
    identity.id,
    identity.orgId,
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assert.deepEqual(
    sortScopes(scopes),
    sortScopes(["relayfile:fs:read:/reports/*", "relayfile:fs:read:/logs/*"]),
  );
});

test("checkAccess returns allow or deny with a reason and matched policy details when relevant", async (t) => {
  const { checkAccess } = await loadPolicyEvaluationModule();

  await t.test("returns allow with a non-empty reason when the identity has the scope", async () => {
    const identity = createStoredIdentity({
      id: "agent_access_allow",
      scopes: ["relayfile:fs:read:/reports/*"],
      roles: [],
    });
    const scenario = createPolicyEvaluationDb({ identities: [identity] });

    const decision = await checkAccess(
      scenario.db,
      identity.id,
      identity.orgId,
      "relayfile:fs:read:/reports/q1.csv",
      createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
    );

    assert.equal(decision.allowed, true);
    assert.equal(typeof decision.reason, "string");
    assert.notEqual(decision.reason.trim(), "");
  });

  await t.test("returns deny with reason and matchedPolicy when a deny policy blocks the request", async () => {
    const identity = createStoredIdentity({
      id: "agent_access_deny",
      scopes: ["cloud:workflow:run:prod-*"],
      roles: [],
    });
    const deny = createPolicy({
      id: "pol_access_deny",
      name: "access-deny",
      effect: "deny",
      scopes: ["cloud:workflow:run:prod-*"],
      priority: 900,
    });
    const scenario = createPolicyEvaluationDb({ identities: [identity], policies: [deny] });

    const decision = await checkAccess(
      scenario.db,
      identity.id,
      identity.orgId,
      "cloud:workflow:run:prod-release",
      createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
    );

    assert.equal(decision.allowed, false);
    assert.equal(typeof decision.reason, "string");
    assert.notEqual(decision.reason.trim(), "");
    assert.equal(decision.matchedPolicy, deny.id);
  });
});

test("budget enforcement in the policy evaluation pipeline denies on budget exceeded and records budget.exceeded", async () => {
  const { checkAccess } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_budget_exceeded",
    scopes: ["cloud:workflow:run:prod-*"],
    roles: [],
    budget: {
      maxActionsPerHour: 10,
      alertThreshold: 0.8,
      autoSuspend: true,
    },
    budgetUsage: {
      actionsThisHour: 11,
      costToday: 0,
      lastResetAt: "2026-03-25T09:00:00.000Z",
    },
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity] });

  const decision = await checkAccess(
    scenario.db,
    identity.id,
    identity.orgId,
    "cloud:workflow:run:prod-release",
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /budget/i);
  assertAuditActionRecorded(scenario.auditWrites, "budget.exceeded");
});

test("budget approaching the threshold records budget.alert without denying an otherwise allowed request", async () => {
  const { checkAccess } = await loadPolicyEvaluationModule();
  const identity = createStoredIdentity({
    id: "agent_budget_alert",
    scopes: ["cloud:workflow:run:prod-*"],
    roles: [],
    budget: {
      maxActionsPerHour: 10,
      alertThreshold: 0.8,
      autoSuspend: true,
    },
    budgetUsage: {
      actionsThisHour: 8,
      costToday: 0,
      lastResetAt: "2026-03-25T09:00:00.000Z",
    },
  });
  const scenario = createPolicyEvaluationDb({ identities: [identity] });

  const decision = await checkAccess(
    scenario.db,
    identity.id,
    identity.orgId,
    "cloud:workflow:run:prod-release",
    createContext({ identityId: identity.id, workspaceId: identity.workspaceId }),
  );

  assert.equal(decision.allowed, true);
  assertAuditActionRecorded(scenario.auditWrites, "budget.alert");
});
