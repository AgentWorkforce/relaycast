// Neon API key is stored directly in Nango credentials (API_KEY auth mode).
// nango.get() / nango.post() automatically inject Authorization: Bearer <apiKey>.

type NangoClient = Record<string, any>;
type JsonRecord = Record<string, unknown>;

export const NEON_CONSUMPTION_METRICS = [
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "public_network_transfer_bytes",
  "private_network_transfer_bytes",
  "snapshot_storage_bytes_month",
  "extra_branches_month",
] as const;

export interface NeonPaginationOptions {
  limit?: number;
  maxPages?: number;
}

export type NeonGranularity = "hourly" | "daily" | "monthly";

export interface RawNeonOrganization extends JsonRecord {
  id: string;
  name: string;
  handle?: string;
  plan?: string;
  managed_by?: string;
  created_at: string;
  updated_at: string;
}

export interface RawNeonProject extends JsonRecord {
  id: string;
  name: string;
  org_id?: string;
  org_name?: string;
  platform_id?: string;
  region_id?: string;
  created_at: string;
  updated_at: string;
}

export interface RawNeonBranch extends JsonRecord {
  id: string;
  project_id: string;
  name: string;
  current_state?: string;
  created_at: string;
  updated_at: string;
}

export interface RawNeonEndpoint extends JsonRecord {
  id: string;
  project_id: string;
  branch_id: string;
  host?: string;
  type?: string;
  current_state?: string;
  created_at: string;
  updated_at: string;
}

export interface RawNeonOperation extends JsonRecord {
  id: string;
  project_id: string;
  branch_id?: string;
  endpoint_id?: string;
  action: string;
  status: string;
  error?: string;
  failures_count: number;
  created_at: string;
  updated_at: string;
  total_duration_ms: number;
}

export interface RawNeonAdvisorIssue extends JsonRecord {
  name: string;
  title: string;
  level: "INFO" | "WARN" | "ERROR";
  facing: string;
  categories: string[];
  description: string;
  detail: string;
  remediation: string;
  metadata: Record<string, unknown>;
  cache_key: string;
}

export interface RawNeonConsumptionMetric extends JsonRecord {
  metric_name: string;
  value: number;
}

export interface RawNeonConsumptionTimeframe extends JsonRecord {
  timeframe_start: string;
  timeframe_end: string;
  metrics: RawNeonConsumptionMetric[];
}

export interface RawNeonConsumptionPeriod extends JsonRecord {
  period_id: string;
  period_plan: string;
  period_start: string;
  period_end?: string;
  consumption: RawNeonConsumptionTimeframe[];
}

export interface RawNeonProjectConsumption extends JsonRecord {
  project_id: string;
  periods: RawNeonConsumptionPeriod[];
}

export interface RawNeonBranchConsumption extends JsonRecord {
  project_id: string;
  branch_id: string;
  periods: RawNeonConsumptionPeriod[];
}

export interface SpendingLimitResult {
  spending_limit_cents?: number | null;
  fetch_status: "ok" | "forbidden" | "not-found" | "error";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Constructed to avoid Nango's literal "console." linter false-positive.
export const NEON_BASE_URL = `https://${"console"}.neon.tech/api/v2`;

export function formatApiUrl(path: string): string {
  return `${NEON_BASE_URL}${path}`;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalField<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Record<TKey, TValue> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<TKey, TValue>);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Core HTTP helpers
// ---------------------------------------------------------------------------

async function neonGet<T = unknown>(
  nango: NangoClient,
  path: string,
  params?: Record<string, string | number | boolean | string[]>,
  retries = 3,
): Promise<T> {
  const response = await nango["get"]({
    endpoint: path,
    baseUrlOverride: NEON_BASE_URL,
    ...(params ? { params } : {}),
    retries,
  });
  return response.data as T;
}

async function neonPost<T = unknown>(
  nango: NangoClient,
  path: string,
  data?: unknown,
  retries = 0,
): Promise<T> {
  const response = await nango["post"]({
    endpoint: path,
    baseUrlOverride: NEON_BASE_URL,
    data,
    retries,
  });
  return response.data as T;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

async function* paginateNeon<TItem>(
  nango: NangoClient,
  path: string,
  responseKey: string,
  baseParams: Record<string, string | number | boolean | string[]> = {},
  options: NeonPaginationOptions = {},
): AsyncGenerator<TItem[], void, void> {
  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 100;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await neonGet<JsonRecord>(nango, path, {
      ...baseParams,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const items = readArray(response[responseKey]);
    yield items as TItem[];
    const pagination = asRecord(response["pagination"]);
    const nextCursor = readString(pagination?.["cursor"]);
    if (!nextCursor) return;
    cursor = nextCursor;
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function listOrganizations(
  nango: NangoClient,
): Promise<RawNeonOrganization[]> {
  const response = await neonGet<JsonRecord>(nango, "/users/me/organizations");
  return readArray(response["organizations"]) as RawNeonOrganization[];
}

export async function listProjects(
  nango: NangoClient,
  input: {
    org_id?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ projects: RawNeonProject[]; next_cursor?: string }> {
  const params: Record<string, string | number | boolean> = { limit: input.limit ?? 100 };
  if (input.org_id) params["org_id"] = input.org_id;
  if (input.search) params["search"] = input.search;
  if (input.cursor) params["cursor"] = input.cursor;

  const response = await neonGet<JsonRecord>(nango, "/projects", params);
  return {
    projects: readArray(response["projects"]) as RawNeonProject[],
    ...optionalField("next_cursor", readString(asRecord(response["pagination"])?.["cursor"])),
  };
}

export async function listAllProjects(
  nango: NangoClient,
  org_id: string,
): Promise<RawNeonProject[]> {
  const projects: RawNeonProject[] = [];
  for await (const page of paginateNeon<RawNeonProject>(nango, "/projects", "projects", { org_id })) {
    projects.push(...page);
  }
  return projects;
}

export async function getProject(
  nango: NangoClient,
  projectId: string,
): Promise<RawNeonProject> {
  const response = await neonGet<JsonRecord>(nango, `/projects/${projectId}`);
  const project = asRecord(response["project"]);
  if (!project) {
    throw new Error(`Neon project ${projectId} response did not include project`);
  }
  return project as RawNeonProject;
}

export async function listBranches(
  nango: NangoClient,
  input: {
    project_id: string;
    search?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ branches: RawNeonBranch[]; next_cursor?: string }> {
  const params: Record<string, string | number | boolean> = {
    sort_by: "updated_at",
    sort_order: "desc",
    limit: input.limit ?? 100,
  };
  if (input.search) params["search"] = input.search;
  if (input.cursor) params["cursor"] = input.cursor;

  const response = await neonGet<JsonRecord>(nango, `/projects/${input.project_id}/branches`, params);
  return {
    branches: readArray(response["branches"]) as RawNeonBranch[],
    ...optionalField("next_cursor", readString(asRecord(response["pagination"])?.["cursor"])),
  };
}

export async function listAllBranches(
  nango: NangoClient,
  projectId: string,
): Promise<RawNeonBranch[]> {
  const branches: RawNeonBranch[] = [];
  for await (const page of paginateNeon<RawNeonBranch>(
    nango,
    `/projects/${projectId}/branches`,
    "branches",
    { sort_by: "updated_at", sort_order: "desc" },
  )) {
    branches.push(...page);
  }
  return branches;
}

export async function listEndpoints(
  nango: NangoClient,
  projectId: string,
): Promise<RawNeonEndpoint[]> {
  const response = await neonGet<JsonRecord>(nango, `/projects/${projectId}/endpoints`);
  return readArray(response["endpoints"]) as RawNeonEndpoint[];
}

export async function listOperations(
  nango: NangoClient,
  input: {
    project_id: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ operations: RawNeonOperation[]; next_cursor?: string }> {
  const params: Record<string, string | number | boolean> = { limit: input.limit ?? 100 };
  if (input.cursor) params["cursor"] = input.cursor;

  const response = await neonGet<JsonRecord>(nango, `/projects/${input.project_id}/operations`, params);
  return {
    operations: readArray(response["operations"]) as RawNeonOperation[],
    ...optionalField("next_cursor", readString(asRecord(response["pagination"])?.["cursor"])),
  };
}

export async function listAllOperations(
  nango: NangoClient,
  projectId: string,
): Promise<RawNeonOperation[]> {
  const operations: RawNeonOperation[] = [];
  for await (const page of paginateNeon<RawNeonOperation>(
    nango,
    `/projects/${projectId}/operations`,
    "operations",
  )) {
    operations.push(...page);
  }
  return operations;
}

export async function createBranch(
  nango: NangoClient,
  input: {
    project_id: string;
    name?: string;
    parent_id?: string;
    parent_lsn?: string;
    parent_timestamp?: string;
    endpoint_type?: "read_write" | "read_only";
  },
): Promise<JsonRecord> {
  const branchBody: JsonRecord = {};
  if (input.name) branchBody["name"] = input.name;
  if (input.parent_id) branchBody["parent_id"] = input.parent_id;
  if (input.parent_lsn) branchBody["parent_lsn"] = input.parent_lsn;
  if (input.parent_timestamp) branchBody["parent_timestamp"] = input.parent_timestamp;

  const body: JsonRecord = { branch: branchBody };
  if (input.endpoint_type) {
    body["endpoints"] = [{ type: input.endpoint_type }];
  }

  return neonPost<JsonRecord>(nango, `/projects/${input.project_id}/branches`, body, 0);
}

export async function getSpendingLimit(
  nango: NangoClient,
  orgId: string,
): Promise<SpendingLimitResult> {
  try {
    const response = await neonGet<JsonRecord>(nango, `/organizations/${orgId}/billing/spending_limit`);
    return {
      fetch_status: "ok",
      ...optionalField(
        "spending_limit_cents",
        typeof response["spending_limit_cents"] === "number" || response["spending_limit_cents"] === null
          ? (response["spending_limit_cents"] as number | null)
          : undefined,
      ),
    };
  } catch (error) {
    const msg = errorMessage(error).toLowerCase();
    if (msg.includes("403") || msg.includes("forbidden")) return { fetch_status: "forbidden" };
    if (msg.includes("404") || msg.includes("not found") || msg.includes("not_found")) return { fetch_status: "not-found" };
    return { fetch_status: "error" };
  }
}

export async function listAdvisorIssues(
  nango: NangoClient,
  input: {
    project_id: string;
    branch_id?: string;
    database_name?: string;
    category?: "SECURITY" | "PERFORMANCE";
    min_severity?: "INFO" | "WARN" | "ERROR";
  },
): Promise<RawNeonAdvisorIssue[]> {
  try {
    const params: Record<string, string | number | boolean> = {};
    if (input.branch_id) params["branch_id"] = input.branch_id;
    if (input.database_name) params["database_name"] = input.database_name;
    if (input.category) params["category"] = input.category;
    if (input.min_severity) params["min_severity"] = input.min_severity;

    const response = await neonGet<JsonRecord>(
      nango,
      `/projects/${input.project_id}/advisors`,
      Object.keys(params).length > 0 ? params : undefined,
    );
    return readArray(response["issues"]) as RawNeonAdvisorIssue[];
  } catch {
    return [];
  }
}

export async function listProjectConsumptionHistory(
  nango: NangoClient,
  input: {
    org_id: string;
    from: string;
    to: string;
    granularity: NeonGranularity;
    project_ids?: readonly string[];
  },
): Promise<RawNeonProjectConsumption[]> {
  const baseParams: Record<string, string | number | boolean | string[]> = {
    org_id: input.org_id,
    from: input.from,
    to: input.to,
    granularity: input.granularity,
    metrics: [...NEON_CONSUMPTION_METRICS],
  };
  if (input.project_ids && input.project_ids.length > 0) {
    baseParams["project_ids"] = [...input.project_ids];
  }

  const projects: RawNeonProjectConsumption[] = [];
  for await (const page of paginateNeon<RawNeonProjectConsumption>(
    nango,
    "/consumption_history/v2/projects",
    "projects",
    baseParams,
    { limit: 100 },
  )) {
    projects.push(...page);
  }
  return projects;
}

export async function listBranchConsumptionHistory(
  nango: NangoClient,
  input: {
    org_id: string;
    from: string;
    to: string;
    granularity: NeonGranularity;
    project_ids?: readonly string[];
    branch_ids?: readonly string[];
  },
): Promise<RawNeonBranchConsumption[]> {
  const baseParams: Record<string, string | number | boolean | string[]> = {
    org_id: input.org_id,
    from: input.from,
    to: input.to,
    granularity: input.granularity,
    metrics: [...NEON_CONSUMPTION_METRICS],
  };
  if (input.project_ids?.length) baseParams["project_ids"] = [...input.project_ids];
  if (input.branch_ids?.length) baseParams["branch_ids"] = [...input.branch_ids];

  const branches: RawNeonBranchConsumption[] = [];
  for await (const page of paginateNeon<RawNeonBranchConsumption>(
    nango,
    "/consumption_history/v2/branches",
    "branches",
    baseParams,
    { limit: 100 },
  )) {
    branches.push(...page);
  }
  return branches;
}
