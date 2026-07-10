import { BY_STATE_SEGMENT, statePathSegment } from "../aliases.js";

export interface LinearIssue {
  id?: unknown;
  identifier?: unknown;
  state?: {
    type?: unknown;
  } | null;
  [key: string]: unknown;
}

export function groupIssuesByState(issues: readonly LinearIssue[]): Record<string, LinearIssue[]> {
  return issues.reduce<Record<string, LinearIssue[]>>((groups, issue) => {
    const state = statePathSegment(issue.state?.type);
    (groups[state] ??= []).push(issue);
    return groups;
  }, {});
}

export function byStateSubtreeForIssue(issue: LinearIssue): string {
  const state = statePathSegment(issue.state?.type);
  const canonicalId = readString(issue.identifier) ?? readString(issue.id) ?? "unknown";
  return `/linear/issues/${BY_STATE_SEGMENT}/${state}/${canonicalId}.json`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
