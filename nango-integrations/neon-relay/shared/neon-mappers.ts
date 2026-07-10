import {
  formatApiUrl,
  type RawNeonAdvisorIssue,
  type RawNeonBranch,
  type RawNeonBranchConsumption,
  type RawNeonConsumptionPeriod,
  type RawNeonConsumptionTimeframe,
  type RawNeonEndpoint,
  type RawNeonOperation,
  type RawNeonOrganization,
  type RawNeonProject,
  type RawNeonProjectConsumption,
  type SpendingLimitResult,
} from "./neon-api.js";

function operationSeverity(status: string): "info" | "low" | "medium" | "high" | "critical" {
  if (status === "failed" || status === "error") return "critical";
  if (status === "cancelled" || status === "cancelling") return "high";
  if (status === "running" || status === "scheduling") return "medium";
  return "low";
}

function issueSeverity(level: RawNeonAdvisorIssue["level"]): "info" | "medium" | "high" | "critical" {
  if (level === "ERROR") return "critical";
  if (level === "WARN") return "high";
  return "medium";
}

function endpointSeverity(state: string | undefined): "info" | "low" | "medium" | "high" | "critical" {
  if (state === "suspended") return "high";
  if (state === "waking" || state === "init") return "medium";
  return "low";
}

function projectConsumptionSeverity(metric: string, value: number): "info" | "low" | "medium" | "high" | "critical" {
  if (metric === "compute_unit_seconds" && value >= 50000) return "high";
  if (metric === "public_network_transfer_bytes" && value >= 5_000_000_000) return "high";
  if (metric === "private_network_transfer_bytes" && value >= 5_000_000_000) return "high";
  if (metric === "snapshot_storage_bytes_month" && value >= 50_000_000_000) return "medium";
  return "low";
}

export function mapOrganizationRecord(organization: RawNeonOrganization) {
  return {
    ...organization,
    source: "neon" as const,
    kind: "inventory" as const,
    occurred_at: organization.updated_at,
    severity: "info" as const,
    title: `Neon organization ${organization.name}`,
    url: formatApiUrl("/users/me/organizations"),
  };
}

export function mapProjectRecord(project: RawNeonProject) {
  return {
    ...project,
    source: "neon" as const,
    kind: "inventory" as const,
    occurred_at: project.updated_at,
    severity: "info" as const,
    title: `Neon project ${project.name}`,
    url: formatApiUrl(`/projects/${project.id}`),
  };
}

export function mapBranchRecord(branch: RawNeonBranch) {
  const severity = branch.current_state === "init" ? ("medium" as const) : ("low" as const);
  return {
    ...branch,
    source: "neon" as const,
    kind: "inventory" as const,
    occurred_at: branch.updated_at,
    severity,
    title: `Neon branch ${branch.name}`,
    url: formatApiUrl(`/projects/${branch.project_id}/branches/${branch.id}`),
  };
}

export function mapEndpointRecord(endpoint: RawNeonEndpoint) {
  return {
    ...endpoint,
    source: "neon" as const,
    kind: "runtime" as const,
    occurred_at: endpoint.updated_at,
    severity: endpointSeverity(endpoint.current_state),
    title: `Neon endpoint ${endpoint.id} ${endpoint.current_state ?? "updated"}`,
    url: formatApiUrl(`/projects/${endpoint.project_id}/endpoints/${endpoint.id}`),
  };
}

export function mapOperationRecord(operation: RawNeonOperation) {
  return {
    ...operation,
    source: "neon" as const,
    kind: "runtime" as const,
    occurred_at: operation.updated_at,
    severity: operationSeverity(operation.status),
    title: `Neon ${operation.action} ${operation.status}`,
    url: formatApiUrl(`/projects/${operation.project_id}/operations/${operation.id}`),
  };
}

export function mapSpendingLimitRecord(
  orgId: string,
  orgName: string | undefined,
  result: SpendingLimitResult,
  capturedAt: string,
) {
  const limitMissing = result.fetch_status === "ok" && result.spending_limit_cents == null;
  const severity = limitMissing
    ? ("medium" as const)
    : result.fetch_status === "ok"
      ? ("low" as const)
      : ("info" as const);
  const title =
    result.fetch_status !== "ok"
      ? `Neon spending limit ${result.fetch_status} for ${orgName ?? orgId}`
      : limitMissing
        ? `No Neon spending limit configured for ${orgName ?? orgId}`
        : `Neon spending limit for ${orgName ?? orgId}`;
  return {
    id: orgId,
    source: "neon" as const,
    kind: "cost" as const,
    occurred_at: capturedAt,
    severity,
    title,
    url: formatApiUrl(`/organizations/${orgId}/billing/spending_limit`),
    org_id: orgId,
    ...(orgName ? { org_name: orgName } : {}),
    ...(result.spending_limit_cents !== undefined
      ? { spending_limit_cents: result.spending_limit_cents }
      : {}),
    fetch_status: result.fetch_status,
    captured_at: capturedAt,
  };
}

export function mapAdvisorIssueRecord(
  projectId: string,
  branchId: string | undefined,
  issue: RawNeonAdvisorIssue,
  capturedAt: string,
) {
  const id = `${projectId}__${branchId ?? "default"}__${issue.cache_key}`;
  return {
    id,
    source: "neon" as const,
    kind: "advisory" as const,
    occurred_at: capturedAt,
    severity: issueSeverity(issue.level),
    title: issue.title,
    url: issue.remediation,
    project_id: projectId,
    ...(branchId ? { branch_id: branchId } : {}),
    issue_name: issue.name,
    level: issue.level,
    facing: issue.facing,
    categories: issue.categories,
    description: issue.description,
    detail: issue.detail,
    remediation: issue.remediation,
    cache_key: issue.cache_key,
    captured_at: capturedAt,
    metadata: issue.metadata,
  };
}

export function expandProjectConsumptionRecords(
  orgId: string,
  project: RawNeonProjectConsumption,
  projectName: string | undefined,
  granularity: "hourly" | "daily" | "monthly",
) {
  return expandConsumptionPeriods({
    orgId,
    projectId: project.project_id,
    ...(projectName ? { projectName } : {}),
    periods: project.periods,
    granularity,
  });
}

export function expandBranchConsumptionRecords(
  orgId: string,
  branch: RawNeonBranchConsumption,
  branchName: string | undefined,
  granularity: "hourly" | "daily" | "monthly",
) {
  return expandConsumptionPeriods({
    orgId,
    projectId: branch.project_id,
    branchId: branch.branch_id,
    ...(branchName ? { branchName } : {}),
    periods: branch.periods,
    granularity,
  });
}

function expandConsumptionPeriods(input: {
  orgId: string;
  projectId: string;
  projectName?: string;
  branchId?: string;
  branchName?: string;
  periods: RawNeonConsumptionPeriod[];
  granularity: "hourly" | "daily" | "monthly";
}) {
  const records: Array<Record<string, unknown>> = [];

  for (const period of input.periods) {
    for (const timeframe of period.consumption) {
      records.push(
        ...expandTimeframe(input, period, timeframe),
      );
    }
  }

  return records;
}

function expandTimeframe(
  input: {
    orgId: string;
    projectId: string;
    projectName?: string;
    branchId?: string;
    branchName?: string;
    granularity: "hourly" | "daily" | "monthly";
  },
  period: RawNeonConsumptionPeriod,
  timeframe: RawNeonConsumptionTimeframe,
) {
  return timeframe.metrics.map((metric) => {
    const prefix = input.branchId ? input.branchId : input.projectId;
    const id = `${prefix}__${metric.metric_name}__${timeframe.timeframe_start}`;
    const titleTarget = input.branchName ?? input.projectName ?? input.branchId ?? input.projectId;
    return {
      id,
      source: "neon" as const,
      kind: "cost" as const,
      occurred_at: timeframe.timeframe_end,
      severity: projectConsumptionSeverity(metric.metric_name, metric.value),
      title: `${titleTarget} ${metric.metric_name}`,
      url: formatApiUrl(
        input.branchId
          ? `/consumption_history/v2/branches`
          : `/consumption_history/v2/projects`,
      ),
      org_id: input.orgId,
      project_id: input.projectId,
      ...(input.projectName ? { project_name: input.projectName } : {}),
      ...(input.branchId ? { branch_id: input.branchId } : {}),
      ...(input.branchName ? { branch_name: input.branchName } : {}),
      metric: metric.metric_name,
      value: metric.value,
      granularity: input.granularity,
      period_id: period.period_id,
      period_plan: period.period_plan,
      period_start: period.period_start,
      period_end: period.period_end ?? timeframe.timeframe_end,
      timeframe_start: timeframe.timeframe_start,
      timeframe_end: timeframe.timeframe_end,
    };
  });
}
