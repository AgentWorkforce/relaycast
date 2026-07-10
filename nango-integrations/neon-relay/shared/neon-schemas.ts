import { z } from "zod";

export const NeonSeverity = z.enum(["info", "low", "medium", "high", "critical"]);

export const NeonOrganizationModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("inventory"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    name: z.string(),
    handle: z.string().optional(),
    plan: z.string().optional(),
    managed_by: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const NeonProjectModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("inventory"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    name: z.string(),
    org_id: z.string().optional(),
    org_name: z.string().optional(),
    platform_id: z.string().optional(),
    region_id: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const NeonBranchModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("inventory"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    project_id: z.string(),
    name: z.string(),
    current_state: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const NeonEndpointModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("runtime"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    project_id: z.string(),
    branch_id: z.string(),
    host: z.string().optional(),
    type: z.string().optional(),
    current_state: z.string().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const NeonOperationModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("runtime"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    project_id: z.string(),
    branch_id: z.string().optional(),
    endpoint_id: z.string().optional(),
    action: z.string(),
    status: z.string(),
    error: z.string().optional(),
    failures_count: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    total_duration_ms: z.number(),
  })
  .passthrough();

export const NeonProjectConsumptionModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("cost"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    org_id: z.string(),
    project_id: z.string(),
    project_name: z.string().optional(),
    metric: z.string(),
    value: z.number(),
    granularity: z.enum(["hourly", "daily", "monthly"]),
    period_id: z.string(),
    period_plan: z.string(),
    period_start: z.string(),
    period_end: z.string(),
    timeframe_start: z.string(),
    timeframe_end: z.string(),
  })
  .passthrough();

export const NeonBranchConsumptionModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("cost"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    org_id: z.string(),
    project_id: z.string(),
    branch_id: z.string(),
    branch_name: z.string().optional(),
    metric: z.string(),
    value: z.number(),
    granularity: z.enum(["hourly", "daily", "monthly"]),
    period_id: z.string(),
    period_plan: z.string(),
    period_start: z.string(),
    period_end: z.string(),
    timeframe_start: z.string(),
    timeframe_end: z.string(),
  })
  .passthrough();

export const NeonSpendingLimitModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("cost"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    org_id: z.string(),
    org_name: z.string().optional(),
    spending_limit_cents: z.number().nullable().optional(),
    fetch_status: z.enum(["ok", "forbidden", "not-found", "error"]),
    captured_at: z.string(),
  })
  .passthrough();

export const NeonAdvisorIssueModel = z
  .object({
    id: z.string(),
    source: z.literal("neon"),
    kind: z.literal("advisory"),
    occurred_at: z.string(),
    severity: NeonSeverity,
    title: z.string(),
    url: z.string(),
    project_id: z.string(),
    branch_id: z.string().optional(),
    issue_name: z.string(),
    level: z.enum(["INFO", "WARN", "ERROR"]),
    facing: z.string(),
    categories: z.array(z.string()),
    description: z.string(),
    detail: z.string(),
    remediation: z.string(),
    cache_key: z.string(),
    captured_at: z.string(),
  })
  .passthrough();

export const ListOrganizationsOutput = z.object({
  organizations: z.array(NeonOrganizationModel),
});

export const ListProjectsInput = z.object({
  org_id: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
});

export const ListProjectsOutput = z.object({
  projects: z.array(NeonProjectModel),
  next_cursor: z.string().optional(),
});

export const GetProjectInput = z.object({
  project_id: z.string(),
});

export const GetProjectOutput = z.object({
  project: NeonProjectModel,
});

export const ListBranchesInput = z.object({
  project_id: z.string(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
});

export const ListBranchesOutput = z.object({
  branches: z.array(NeonBranchModel),
  next_cursor: z.string().optional(),
});

export const ListEndpointsInput = z.object({
  project_id: z.string(),
});

export const ListEndpointsOutput = z.object({
  endpoints: z.array(NeonEndpointModel),
});

export const ListOperationsInput = z.object({
  project_id: z.string(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
});

export const ListOperationsOutput = z.object({
  operations: z.array(NeonOperationModel),
  next_cursor: z.string().optional(),
});

export const CreateBranchInput = z.object({
  project_id: z.string(),
  name: z.string().optional(),
  parent_id: z.string().optional(),
  parent_lsn: z.string().optional(),
  parent_timestamp: z.string().optional(),
  endpoint_type: z.enum(["read_write", "read_only"]).optional(),
});

export const CreateBranchOutput = z.object({
  branch: NeonBranchModel,
  endpoint: NeonEndpointModel.optional(),
  operation_ids: z.array(z.string()),
});

export const GetSpendingLimitInput = z.object({
  org_id: z.string(),
});

export const GetSpendingLimitOutput = z.object({
  spending_limit: NeonSpendingLimitModel,
});

export const ListAdvisorIssuesInput = z.object({
  project_id: z.string(),
  branch_id: z.string().optional(),
  database_name: z.string().optional(),
  category: z.enum(["SECURITY", "PERFORMANCE"]).optional(),
  min_severity: z.enum(["INFO", "WARN", "ERROR"]).optional(),
});

export const ListAdvisorIssuesOutput = z.object({
  issues: z.array(NeonAdvisorIssueModel),
});
