import type { CorpusEntry } from "./corpus.js";
import type { ReplayedResponse } from "./replay.js";

export type EquivalenceKind = "identical" | "allowlisted" | "divergent";
export type AllowlistKind = "ignore" | "regex" | "type-only";

export interface AllowlistEntry {
  path: string;
  method: string;
  field: string;
  kind: AllowlistKind;
  pattern?: string;
  reason: string;
}

export interface DifferenceDetail {
  field: string;
  expected: unknown;
  actual: unknown;
  reason?: string;
}

export interface EquivalenceDetails {
  path: string;
  method: string;
  requestId: string;
  allowlistedDifferences: DifferenceDetail[];
  divergentDifferences: DifferenceDetail[];
}

export interface EquivalenceResult {
  kind: EquivalenceKind;
  details: EquivalenceDetails;
}

interface GroupedAllowlistConfig {
  body?: {
    json_paths?: unknown;
  };
  headers?: {
    json_paths?: unknown;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseJson(value: string | null): unknown | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed !== "null") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function valuesAreDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function matchingAllowlistEntry(
  entries: AllowlistEntry[],
  method: string,
  routePath: string,
  field: string,
): AllowlistEntry | undefined {
  return entries.find((entry) => {
    const pathMatches = entry.path === "*" || entry.path === routePath;
    const methodMatches = entry.method === "*" || entry.method === method;
    return pathMatches && methodMatches && entry.field === field;
  });
}

function allowDifference(entry: AllowlistEntry, expected: unknown, actual: unknown): boolean {
  if (entry.kind === "ignore") {
    return true;
  }

  if (entry.kind === "type-only") {
    return valueType(expected) === valueType(actual);
  }

  const pattern = entry.pattern ? new RegExp(entry.pattern) : null;
  if (!pattern) {
    return false;
  }
  return pattern.test(String(expected)) && pattern.test(String(actual));
}

function pushDifference(
  details: EquivalenceDetails,
  entries: AllowlistEntry[],
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  const entry = matchingAllowlistEntry(entries, details.method, details.path, field);
  const difference: DifferenceDetail = {
    field,
    expected,
    actual,
    reason: entry?.reason,
  };

  if (entry && allowDifference(entry, expected, actual)) {
    details.allowlistedDifferences.push(difference);
    return;
  }

  details.divergentDifferences.push(difference);
}

function compareJsonValue(
  details: EquivalenceDetails,
  entries: AllowlistEntry[],
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (valuesAreDeepEqual(expected, actual)) {
    return;
  }

  if (field.length > 0) {
    const entry = matchingAllowlistEntry(entries, details.method, details.path, field);
    if (entry && allowDifference(entry, expected, actual)) {
      details.allowlistedDifferences.push({
        field,
        expected,
        actual,
        reason: entry.reason,
      });
      return;
    }
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const maxLength = Math.max(expected.length, actual.length);
    for (let index = 0; index < maxLength; index += 1) {
      const childField = field.length > 0 ? `${field}.${index}` : String(index);
      compareJsonValue(details, entries, childField, expected[index], actual[index]);
    }
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const childField = field.length > 0 ? `${field}.${key}` : key;
      compareJsonValue(details, entries, childField, expected[key], actual[key]);
    }
    return;
  }

  pushDifference(details, entries, field || "body", expected, actual);
}

function compareHeaders(
  details: EquivalenceDetails,
  entries: AllowlistEntry[],
  expected: Record<string, string>,
  actual: Record<string, string>,
): void {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of names) {
    const expectedValue = expected[name];
    const actualValue = actual[name];
    if (expectedValue === actualValue) {
      continue;
    }
    pushDifference(details, entries, `header.${name}`, expectedValue, actualValue);
  }
}

function compareBodies(
  details: EquivalenceDetails,
  entries: AllowlistEntry[],
  expectedBody: string | null,
  actualBody: string,
): void {
  if ((expectedBody ?? "") === actualBody) {
    return;
  }

  const expectedJson = safeParseJson(expectedBody);
  const actualJson = safeParseJson(actualBody);
  if (expectedJson !== undefined && actualJson !== undefined) {
    compareJsonValue(details, entries, "", expectedJson, actualJson);
    return;
  }

  pushDifference(details, entries, "body", expectedBody, actualBody);
}

export function parseAllowlistEntries(value: unknown): AllowlistEntry[] {
  let entries: unknown;
  if (Array.isArray(value)) {
    entries = value;
  } else if (isPlainObject(value)) {
    const grouped = value as GroupedAllowlistConfig;
    const bodyEntries = Array.isArray(grouped.body?.json_paths) ? grouped.body.json_paths : [];
    const headerEntries = Array.isArray(grouped.headers?.json_paths) ? grouped.headers.json_paths : [];
    entries = [...bodyEntries, ...headerEntries];
  } else {
    throw new Error(
      "equivalence allowlist must be an array or an object with body.json_paths and headers.json_paths arrays.",
    );
  }

  if (!Array.isArray(entries)) {
    throw new Error("equivalence allowlist entries must resolve to an array.");
  }

  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`Allowlist entry ${index} must be an object.`);
    }
    const path = entry.path;
    const method = entry.method;
    const field = entry.field;
    const kind = entry.kind;
    const pattern = entry.pattern;
    const reason = entry.reason;

    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`Allowlist entry ${index} is missing a path.`);
    }
    if (typeof method !== "string" || method.length === 0) {
      throw new Error(`Allowlist entry ${index} is missing a method.`);
    }
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(`Allowlist entry ${index} is missing a field.`);
    }
    if (kind !== "ignore" && kind !== "regex" && kind !== "type-only") {
      throw new Error(`Allowlist entry ${index} has unsupported kind '${String(kind)}'.`);
    }
    if (kind === "regex" && (typeof pattern !== "string" || pattern.length === 0)) {
      throw new Error(`Allowlist entry ${index} requires a non-empty pattern.`);
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(`Allowlist entry ${index} requires a non-empty reason.`);
    }

    return {
      path,
      method: method.toUpperCase(),
      field,
      kind,
      pattern: typeof pattern === "string" ? pattern : undefined,
      reason: reason.trim(),
    };
  });
}

export function compareReplayResult(
  expected: CorpusEntry,
  actual: ReplayedResponse,
  allowlist: AllowlistEntry[],
): EquivalenceResult {
  const details: EquivalenceDetails = {
    path: expected.path,
    method: expected.method,
    requestId: expected.request_id,
    allowlistedDifferences: [],
    divergentDifferences: [],
  };

  if (expected.response_status !== actual.status) {
    pushDifference(details, allowlist, "status", expected.response_status, actual.status);
  }

  compareHeaders(details, allowlist, expected.response_headers, actual.headers);
  compareBodies(details, allowlist, expected.response_body, actual.body);

  if (details.divergentDifferences.length > 0) {
    return { kind: "divergent", details };
  }
  if (details.allowlistedDifferences.length > 0) {
    return { kind: "allowlisted", details };
  }
  return { kind: "identical", details };
}
