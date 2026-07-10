import type {
  LinearEntityType,
  LinearLibrarianOptions,
} from "@agent-assistant/specialists";
import type { VfsEntry } from "@agent-assistant/vfs";
import {
  LINEAR_LIST_ISSUES_QUERY,
  buildLinearIssueFilter as buildIssueFilter,
  linearIssuePath,
  linearProjectPath,
} from "@relayfile/adapter-linear";

import type {
  LinearIntegration,
  LinearIssueListOptions,
  LinearProjectListOptions,
  LinearSearchIssueOptions,
} from "./linear-api-client.js";

const LOG_PREFIX = "[specialist/api-fallback]";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const LINEAR_PROVIDER = "linear";
const LINEAR_LIST_ISSUES_SUPPORTS_FILTERS = LINEAR_LIST_ISSUES_QUERY.includes(
  "$filter: IssueFilter",
);

type LinearEnumerationType = Extract<LinearEntityType, "issue" | "project">;
// Narrow the upstream union to the function-call variant. The agent-assistant
// LibrarianApiFallback<T> type accepts EITHER `(req) => Promise<entries>` OR
// `{ list?, search? }`, but every cloud-side fallback (github + linear)
// implements the function variant, and tests need a concrete callable type
// to invoke without an `as` cast.
type LinearLibrarianApiFallback = Extract<
  NonNullable<LinearLibrarianOptions["apiFallback"]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]) => unknown
>;
type JsonObject = Record<string, unknown>;
type WrappedResult<T> =
  | { data: T; summary?: string; source?: string; timestamp?: string }
  | T;
type FallbackVfsEntry = VfsEntry & {
  content: string;
  contentType: "application/json";
};

interface LinearLibrarianFallbackRequest {
  instruction: string;
  text: string;
  filters: Record<string, string[]>;
  types: LinearEntityType[];
}

type LinearSearchResult =
  | readonly JsonObject[]
  | {
      items?: readonly JsonObject[];
      nodes?: readonly JsonObject[];
      results?: readonly JsonObject[];
      issues?: readonly JsonObject[];
      projects?: readonly JsonObject[];
    };

type LinearIntegrationWithOptionalMethods = LinearIntegration & {
  listIssues?: (
    options?: LinearIssueListOptions,
  ) => Promise<WrappedResult<readonly JsonObject[] | null> | null>;
  searchIssues?: (
    query: string,
    options?: LinearSearchIssueOptions,
  ) => Promise<WrappedResult<LinearSearchResult | null> | null>;
  listProjects?: (
    options?: LinearProjectListOptions,
  ) => Promise<WrappedResult<readonly JsonObject[] | null> | null>;
};

interface LoadContext {
  filters: Record<string, string[]>;
  limit: number;
}

type SharedIssueFilterInput = Parameters<typeof buildIssueFilter>[0];

export function createLinearLibrarianApiFallback(
  linear: LinearIntegration,
): LinearLibrarianApiFallback {
  const integration = linear as LinearIntegrationWithOptionalMethods;

  return async (
    request: LinearLibrarianFallbackRequest,
  ): Promise<readonly FallbackVfsEntry[]> => {
    const filters = filtersFromRequest(request);
    const types = typesFromRequest(request, filters);
    const limit = limitFromRequest(request);

    logInvocation("linear librarian fallback invoked", {
      types,
      filters,
      hasText: queryMetadataFromRequest(request).length > 0,
      limit,
    });

    const context: LoadContext = { filters, limit };
    const entries: FallbackVfsEntry[] = [];

    for (const type of types) {
      try {
        entries.push(...(await loadEnumerationType(integration, type, context)));
      } catch (error) {
        logFailure(`linear ${type} fallback failed`, error);
      }

      if (entries.length >= limit) {
        break;
      }
    }

    return dedupeEntries(entries).slice(0, limit);
  };
}

async function loadEnumerationType(
  integration: LinearIntegrationWithOptionalMethods,
  type: LinearEnumerationType,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  if (type === "project") {
    return loadProjectEntries(integration, context);
  }

  const issueSearchQuery = issueSearchQueryFromFilters(context.filters);
  if (issueSearchQuery) {
    const searchEntries = await loadIssueEntriesFromSearch(
      integration,
      issueSearchQuery,
      context.limit,
    );
    if (searchEntries.length > 0) {
      return searchEntries;
    }
  }

  return loadIssueEntriesFromList(integration, context);
}

async function loadIssueEntriesFromList(
  integration: LinearIntegrationWithOptionalMethods,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  if (!integration.listIssues) {
    return [];
  }

  const result = await safeLinearCall("list issues", () =>
    integration.listIssues?.(buildIssueListOptions(context.filters, context.limit)),
  );

  return recordsFromResult(result)
    .map((item) => toLinearEntry("issue", item))
    .filter(isDefined)
    .slice(0, context.limit);
}

async function loadIssueEntriesFromSearch(
  integration: LinearIntegrationWithOptionalMethods,
  query: string,
  limit: number,
): Promise<FallbackVfsEntry[]> {
  if (!integration.searchIssues) {
    return [];
  }

  const result = await safeLinearCall("search issues", () =>
    integration.searchIssues?.(query, { limit }),
  );

  return recordsFromResult(result)
    .map((item) => toLinearEntry("issue", item))
    .filter(isDefined)
    .slice(0, limit);
}

async function loadProjectEntries(
  integration: LinearIntegrationWithOptionalMethods,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  if (!integration.listProjects) {
    return [];
  }

  const result = await safeLinearCall("list projects", () =>
    integration.listProjects?.(
      buildProjectListOptions(context.filters, context.limit),
    ),
  );

  return recordsFromResult(result)
    .map((item) => toLinearEntry("project", item))
    .filter(isDefined)
    .slice(0, context.limit);
}

function buildIssueListOptions(
  filters: Record<string, string[]>,
  limit: number,
): LinearIssueListOptions {
  const issueFilterInput = issueFilterInputFromFilters(filters);

  if (
    !LINEAR_LIST_ISSUES_SUPPORTS_FILTERS
    || !buildIssueFilter(issueFilterInput)
  ) {
    return { limit };
  }

  return {
    ...(issueFilterInput.state?.[0]
      ? { state: issueFilterInput.state[0] }
      : {}),
    ...(issueFilterInput.team
      ? { team: issueFilterInput.team }
      : {}),
    ...(issueFilterInput.assignee
      ? { assignee: issueFilterInput.assignee }
      : {}),
    ...(issueFilterInput.labels?.length
      ? { labels: issueFilterInput.labels }
      : {}),
    limit,
  };
}

function buildProjectListOptions(
  filters: Record<string, string[]>,
  limit: number,
): LinearProjectListOptions {
  return {
    ...(firstFilterValue(filters, "state")
      ? { state: firstFilterValue(filters, "state") }
      : {}),
    ...(firstFilterValue(filters, "team")
      ? { team: firstFilterValue(filters, "team") }
      : {}),
    limit,
  };
}

function issueSearchQueryFromFilters(
  filters: Record<string, string[]>,
): string | undefined {
  const candidates = [
    ...(filters.id ?? []),
    ...(filters.identifier ?? []),
    ...(filters.issue ?? []),
    ...(filters.number ?? []),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return candidates.length > 0 ? candidates.join(" ") : undefined;
}

function issueFilterInputFromFilters(
  filters: Record<string, string[]>,
): SharedIssueFilterInput {
  const state = firstFilterValue(filters, "state");

  return {
    state: state ? [state] : undefined,
    labels: unique([...(filters.label ?? []), ...(filters.labels ?? [])]),
    assignee: firstFilterValue(filters, "assignee"),
    team: firstFilterValue(filters, "team"),
    project: firstFilterValue(filters, "project"),
  };
}

function toLinearEntry(
  type: LinearEnumerationType,
  item: JsonObject,
): FallbackVfsEntry | null {
  const id = firstString(item.id, item.identifier);
  if (!id) {
    return null;
  }

  const identifier = firstString(item.identifier);
  const title =
    firstString(item.title, item.name, identifier) ??
    (type === "issue" ? `Issue ${id}` : `Project ${id}`);
  const url = firstString(item.url);
  const updatedAt = firstString(item.updatedAt, item.updated_at);
  const createdAt = firstString(item.createdAt, item.created_at);
  const stateDetails = stateDetailsFromValue(type, item);
  const teamDetails = teamDetailsFromValue(type, item);
  const assigneeDetails = assigneeDetailsFromValue(item);
  const priorityDetails = priorityDetailsFromValue(item.priority);
  const labels = labelsFromValue(item.labels);
  const projectDetails = projectDetailsFromValue(type, item);
  const path = type === "issue" ? linearIssuePath(id) : linearProjectPath(id);

  const properties: Record<string, string> = {
    id,
    type,
    title,
    identifier: identifier ?? "",
    url: url ?? "",
    state: stateDetails.filterValue,
    status: stateDetails.filterValue,
    stateName: stateDetails.displayValue,
    team: teamDetails.filterValue,
    teamName: teamDetails.displayValue,
    teamKey: teamDetails.key,
    teamId: teamDetails.id,
    assignee: assigneeDetails.filterValue,
    assigneeName: assigneeDetails.displayValue,
    assigneeEmail: assigneeDetails.email,
    assigneeId: assigneeDetails.id,
    priority: priorityDetails.filterValue,
    priorityLabel: priorityDetails.label,
    priorityName: priorityDetails.label,
    project: projectDetails.filterValue,
    projectName: projectDetails.displayValue,
    projectId: projectDetails.id,
    labels: JSON.stringify(labels),
    label: labels.join(","),
    updatedAt: updatedAt ?? "",
    createdAt: createdAt ?? "",
    number: identifier ?? "",
  };

  const content = safeStringify({
    type,
    id,
    identifier,
    title,
    url,
    state: stateDetails.displayValue || stateDetails.filterValue || null,
    team: teamDetails.displayValue || null,
    assignee: assigneeDetails.displayValue || null,
    priority: priorityDetails.label || priorityDetails.filterValue || null,
    labels,
    project: projectDetails.displayValue || null,
    updatedAt,
    createdAt,
    raw: item,
  });

  return {
    path,
    type: "file",
    provider: LINEAR_PROVIDER,
    title,
    ...(updatedAt ? { updatedAt } : {}),
    size: content.length,
    properties,
    content,
    contentType: "application/json",
  };
}

function stateDetailsFromValue(
  type: LinearEnumerationType,
  item: JsonObject,
): { filterValue: string; displayValue: string } {
  if (type === "project") {
    const rawState = firstString(item.state);
    return {
      filterValue: canonicalStateValue(rawState),
      displayValue: rawState ?? "",
    };
  }

  const state = asRecord(item.state);
  const rawState = firstString(state.name, state.type, item.stateName, item.status);
  return {
    filterValue: canonicalStateValue(firstString(state.type, rawState)),
    displayValue: rawState ?? "",
  };
}

function teamDetailsFromValue(
  type: LinearEnumerationType,
  item: JsonObject,
): { filterValue: string; displayValue: string; key: string; id: string } {
  if (type === "issue") {
    const team = asRecord(item.team);
    return {
      filterValue:
        firstString(team.name, team.key, team.id) ??
        "",
      displayValue: firstString(team.name, team.key, team.id) ?? "",
      key: firstString(team.key) ?? "",
      id: firstString(team.id) ?? "",
    };
  }

  const teams = Array.isArray(item.teams)
    ? item.teams.filter(isRecord)
    : [];
  return {
    filterValue: teams
      .map((team) => firstString(team.name, team.key, team.id))
      .filter(isDefined)
      .join(","),
    displayValue: teams
      .map((team) => firstString(team.name, team.key, team.id))
      .filter(isDefined)
      .join(","),
    key: teams
      .map((team) => firstString(team.key))
      .filter(isDefined)
      .join(","),
    id: teams
      .map((team) => firstString(team.id))
      .filter(isDefined)
      .join(","),
  };
}

function assigneeDetailsFromValue(
  item: JsonObject,
): { filterValue: string; displayValue: string; email: string; id: string } {
  const assignee = asRecord(item.assignee);
  return {
    filterValue:
      firstString(
        assignee.name,
        assignee.displayName,
        assignee.display_name,
        assignee.email,
        assignee.id,
      ) ?? "",
    displayValue:
      firstString(
        assignee.name,
        assignee.displayName,
        assignee.display_name,
        assignee.email,
        assignee.id,
      ) ?? "",
    email: firstString(assignee.email) ?? "",
    id: firstString(assignee.id) ?? "",
  };
}

function priorityDetailsFromValue(
  value: unknown,
): { filterValue: string; label: string } {
  const priorityNumber = readNumber(value);
  if (priorityNumber === undefined) {
    const raw = firstString(value) ?? "";
    return { filterValue: raw, label: raw };
  }

  return {
    filterValue: String(priorityNumber),
    label: linearPriorityLabel(priorityNumber),
  };
}

function projectDetailsFromValue(
  type: LinearEnumerationType,
  item: JsonObject,
): { filterValue: string; displayValue: string; id: string } {
  if (type === "project") {
    const id = firstString(item.id) ?? "";
    const name = firstString(item.name, id) ?? "";
    return {
      filterValue: name,
      displayValue: name,
      id,
    };
  }

  const project = asRecord(item.project);
  return {
    filterValue:
      firstString(project.name, project.id) ?? "",
    displayValue:
      firstString(project.name, project.id) ?? "",
    id: firstString(project.id) ?? "",
  };
}

function canonicalStateValue(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[-_]+/g, " ");
  if (!normalized) {
    return "";
  }
  if (["done", "completed", "complete"].includes(normalized)) {
    return "done";
  }
  if (["cancelled", "canceled"].includes(normalized)) {
    return "cancelled";
  }
  if (
    [
      "backlog",
      "planned",
      "started",
      "unstarted",
      "triage",
      "in progress",
      "inprogress",
      "review",
      "todo",
      "to do",
      "open",
      "paused",
    ].includes(normalized)
  ) {
    return "open";
  }
  return normalized;
}

function linearPriorityLabel(value: number): string {
  if (value <= 0) {
    return "none";
  }
  if (value === 1) {
    return "urgent";
  }
  if (value === 2) {
    return "high";
  }
  if (value === 3) {
    return "medium";
  }
  if (value === 4) {
    return "low";
  }
  return String(value);
}

function filtersFromRequest(request: unknown): Record<string, string[]> {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const directFilters = readFilterRecord(record.filters);
  const paramsFilters = readFilterRecord(params.filters);
  const directKeys = readKnownFilterKeys(record);
  const paramsKeys = readKnownFilterKeys(params);

  return mergeFilters(directFilters, paramsFilters, directKeys, paramsKeys);
}

function readKnownFilterKeys(
  record: Record<string, unknown>,
): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const key of [
    "state",
    "team",
    "assignee",
    "priority",
    "project",
    "label",
    "labels",
    "type",
  ]) {
    const values = readStringArray(record[key]);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function queryMetadataFromRequest(request: unknown): string {
  const record = asRecord(request);
  const params = asRecord(record.params);
  return (
    firstString(params.query, record.query, record.text, record.instruction) ??
    ""
  );
}

function limitFromRequest(request: unknown): number {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested =
    readNumber(params.limit) ??
    readNumber(record.limit) ??
    DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
}

function typesFromRequest(
  request: unknown,
  filters: Record<string, string[]>,
): LinearEnumerationType[] {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested = [
    ...readStringArray(record.types),
    ...readStringArray(params.types),
    ...(filters.type ?? []),
  ]
    .map(normalizeEnumerationType)
    .filter(isDefined);

  const deduped = [...new Set(requested)];
  return deduped.length > 0 ? deduped : ["issue", "project"];
}

function normalizeEnumerationType(
  value: string,
): LinearEnumerationType | undefined {
  const normalized = value.trim().toLowerCase();
  if (["issue", "issues"].includes(normalized)) {
    return "issue";
  }
  if (["project", "projects"].includes(normalized)) {
    return "project";
  }
  return undefined;
}

function recordsFromResult(value: unknown): JsonObject[] {
  if (isFailedIntegrationResult(value)) {
    return [];
  }

  const data = unwrapData(value);
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (!isRecord(data)) {
    return [];
  }

  for (const key of ["items", "nodes", "results", "issues", "projects"]) {
    const candidate = data[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  return [];
}

function unwrapData(value: unknown): unknown {
  if (
    isRecord(value) &&
    "data" in value &&
    ("summary" in value || "source" in value || "timestamp" in value)
  ) {
    return value.data;
  }
  return value;
}

function isFailedIntegrationResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const summary = firstString(value.summary)?.toLowerCase();
  return Boolean(
    summary &&
      (summary.includes("request failed") ||
        summary.includes("rate limit") ||
        summary.includes("not found") ||
        summary.includes("missing connection") ||
        summary.includes("connection not found")),
  );
}

async function safeLinearCall<T>(
  action: string,
  loader: () => Promise<T | null | undefined>,
): Promise<T | null> {
  try {
    return (await loader()) ?? null;
  } catch (error) {
    logFailure(`linear ${action} failed`, error);
    return null;
  }
}

function labelsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item) ? firstString(item.name, item.id) : firstString(item),
      )
      .filter(isDefined);
  }

  const text = firstString(value);
  if (!text) {
    return [];
  }

  if (text.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return labelsFromValue(parsed);
      }
    } catch {
      // Fall through to comma-separated labels.
    }
  }

  return text
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function hasStructuredFilters(filters: Record<string, string[]>): boolean {
  return Object.entries(filters).some(
    ([key, values]) => key !== "type" && values.some((value) => value.trim()),
  );
}

function firstFilterValue(
  filters: Record<string, string[]>,
  key: string,
): string | undefined {
  return filters[key]?.find((value) => value.trim().length > 0);
}

function mergeFilters(
  ...sources: Record<string, string[]>[]
): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [key, values] of Object.entries(source)) {
      output[key] = unique([...(output[key] ?? []), ...values]);
    }
  }
  return output;
}

function readFilterRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const values = readStringArray(raw);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => firstString(item)).filter(isDefined);
  }
  const text = firstString(value);
  return text ? [text] : [];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function dedupeEntries(entries: FallbackVfsEntry[]): FallbackVfsEntry[] {
  const seen = new Set<string>();
  const output: FallbackVfsEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    output.push(entry);
  }
  return output;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function logInvocation(message: string, metadata: Record<string, unknown>): void {
  console.info(LOG_PREFIX, message, metadata);
}

function logFailure(message: string, error: unknown): void {
  console.warn(LOG_PREFIX, message, errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isRecord(error)) {
    const response = asRecord(error.response);
    const status = firstString(response.status);
    const data = asRecord(response.data);
    const message = firstString(data.message, error.message);
    return [status ? `status ${status}` : undefined, message]
      .filter(isDefined)
      .join(": ");
  }
  return String(error);
}
