import type { WorkflowFileType, WorkflowSourceFileType } from "@/lib/workflows";

/**
 * Allow-list mapping of public workflow slugs → concrete workflow files on
 * a known storage location. This registry is the only way the lightweight
 * `/api/v1/workspaces/:workspaceId/workflows/run` shim can resolve a slug into
 * a real workflow definition; anything not listed here is rejected with a 404
 * so the surface area exposed to MCP clients stays explicit.
 */
export interface WorkflowInvocationEntry {
  /** Public slug callers pass in as `name`. Stable contract — do not rename. */
  slug: string;
  /** Pre-staged workflow bundle key consumed by the heavy workflow engine. */
  s3CodeKey: string;
  /** File type so the heavy endpoint can pick the right bootstrap. */
  fileType: WorkflowFileType;
  /** Original source type to persist for display and replay. */
  sourceFileType?: WorkflowSourceFileType;
  /** Workflow path inside the staged bundle, when the bundle contains a repo. */
  workflowPath?: string;
  /** Minimal workflow source forwarded through the heavy route contract. */
  workflow: string;
  /**
   * Short human description surfaced in the 404 response when an unknown slug
   * is requested, so callers see what is registered.
   */
  description?: string;
}

export interface WorkflowGithubWriteGrant {
  /** Workflow slug from trusted runtime metadata. */
  slug: string;
  /** Exact repository the registered workflow may write to. */
  owner: string;
  repo: string;
  /**
   * Sandbox env names that receive the minted token. An empty list keeps the
   * server-side write grant for authorization without minting a raw sandbox
   * token.
   */
  envTokenNames: readonly string[];
  description?: string;
}

/**
 * The registry. Mutating this list is the explicit registration step — every
 * entry added here becomes a publicly invokable workflow slug.
 */
export const WORKFLOW_INVOCATION_REGISTRY: readonly WorkflowInvocationEntry[] = [
  {
    slug: "echo",
    s3CodeKey: "workflows/echo/latest.tar.gz",
    fileType: "ts",
    workflowPath: "workflow.ts",
    workflow: [
      "const rawInvocationArgs = process.env.invocationArgs ?? '{}';",
      "let invocationArgs: unknown = {};",
      "",
      "try {",
      "  invocationArgs = JSON.parse(rawInvocationArgs);",
      "} catch {",
      "  invocationArgs = rawInvocationArgs;",
      "}",
      "",
      "console.log(JSON.stringify({ ok: true, args: invocationArgs }));",
      "",
    ].join("\n"),
    description: "Minimal proof-of-life workflow for MCP workflow.run that echoes invocation args.",
  },
];

/**
 * Phase-C write grants for proactive workflows. These entries are not public
 * invocation registrations; they only let the heavy workflow route derive repo
 * authority from a server-side registry when a verified delegated persona run
 * carries the matching invocation slug in metadata.
 */
export const WORKFLOW_GITHUB_WRITE_GRANTS: readonly WorkflowGithubWriteGrant[] = [
  {
    slug: "cloud-small-issue-codex",
    owner: "AgentWorkforce",
    repo: "cloud",
    // Path 2 writes through /api/v1/github/pull-request; no raw GitHub token
    // should be minted into the sandbox for this persona.
    envTokenNames: [],
    description: "Small-issue persona may open PRs in AgentWorkforce/cloud via the server-side proxy endpoint.",
  },
  {
    slug: "cloud-complex-issue-workflow",
    owner: "AgentWorkforce",
    repo: "cloud",
    // Path 2 writes through /api/v1/github/pull-request; no raw GitHub token
    // should be minted into the sandbox for this persona.
    envTokenNames: [],
    description: "Complex-issue persona may open PRs in AgentWorkforce/cloud via the server-side proxy endpoint.",
  },
  {
    slug: "linear-chat-lead",
    owner: "AgentWorkforce",
    repo: "cloud",
    // The chat lead delegates implementation to a workflow but still writes PRs
    // through /api/v1/github/pull-request, so keep raw GitHub tokens out of the
    // sandbox and rely on the forwarded relayfile persona token.
    envTokenNames: [],
    description: "Linear chat lead may open delegated implementation PRs in AgentWorkforce/cloud via the server-side proxy endpoint.",
  },
];

export function resolveWorkflowSlug(
  slug: string,
): WorkflowInvocationEntry | undefined {
  const trimmed = slug.trim();
  if (!trimmed) return undefined;
  return WORKFLOW_INVOCATION_REGISTRY.find((entry) => entry.slug === trimmed);
}

export function resolveWorkflowGithubWriteGrant(
  slug: string | null | undefined,
): WorkflowGithubWriteGrant | undefined {
  const trimmed = slug?.trim();
  if (!trimmed) return undefined;
  return WORKFLOW_GITHUB_WRITE_GRANTS.find((entry) => entry.slug === trimmed);
}

export function resolveWorkflowGithubWriteGrantForRepo(
  owner: string,
  repo: string,
): WorkflowGithubWriteGrant | undefined {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = repo.trim().toLowerCase();
  if (!normalizedOwner || !normalizedRepo) return undefined;
  return WORKFLOW_GITHUB_WRITE_GRANTS.find((entry) =>
    entry.owner.toLowerCase() === normalizedOwner &&
    entry.repo.toLowerCase() === normalizedRepo
  );
}

export function resolveWorkflowGithubWriteGrantForRepoAndSlug(
  owner: string,
  repo: string,
  slug: string,
): WorkflowGithubWriteGrant | undefined {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepo = repo.trim().toLowerCase();
  const normalizedSlug = slug.trim();
  if (!normalizedOwner || !normalizedRepo || !normalizedSlug) return undefined;
  return WORKFLOW_GITHUB_WRITE_GRANTS.find((entry) =>
    entry.owner.toLowerCase() === normalizedOwner &&
    entry.repo.toLowerCase() === normalizedRepo &&
    entry.slug === normalizedSlug
  );
}

export function listRegisteredSlugs(): string[] {
  return WORKFLOW_INVOCATION_REGISTRY.map((entry) => entry.slug);
}
