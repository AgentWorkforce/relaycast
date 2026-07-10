import {
  findSlackIntegrationByTeamId,
  findWorkspaceIntegrationByInstallation,
  getWorkspaceIntegration,
  looksLikeSlackTeamId,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import type { WorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import { looksLikeWorkspaceId } from "@/lib/integrations/workspace-identifiers";

/**
 * Canonical workspace identity resolver used by every cloud proxy route.
 *
 * Problem this solves:
 *   A cloud proxy route needs a cloud workspace UUID to look up the
 *   relevant workspace_integrations row (to read the Nango connection id,
 *   the provider config key, metadata, etc.). But callers often don't
 *   have the UUID — they only have whatever external identifier arrived
 *   in the webhook that triggered the call:
 *
 *     - Slack webhooks carry a `team_id` (e.g. "T024BE91L")
 *     - GitHub App webhooks carry an `installation.id`
 *     - Notion sync webhooks carry a workspace-scoped connection id
 *     - Linear webhooks carry an organization id
 *
 *   Before this helper, each proxy route would re-implement the same
 *   "try UUID, else try provider-scoped id" dance inline. That's both
 *   repetition and a consistency hazard — it's easy to accidentally
 *   tighten or loosen the resolution rules in one place and not others.
 *
 * Contract:
 *   Every proxy route calls `resolveWorkspace(input, { provider })` with
 *   whatever identifiers the request body carried. Exactly one
 *   provider-scoped lookup runs per call — the resolver never scans
 *   across provider types. UUID is the fast path (zero DB hits when the
 *   string is a valid UUID that maps to a workspace_integrations row for
 *   the requested provider).
 *
 * Extending to new providers:
 *   Add the new external identifier as an optional field in
 *   `ResolveWorkspaceInput`, then add a case in `resolveProviderScopedIdentity`
 *   that calls the right `findWorkspaceIntegrationBy...` helper. No
 *   changes needed in proxy route code that already calls
 *   `resolveWorkspace` — it just picks up the new field.
 */

export type ResolveWorkspaceInput = {
  /** Direct cloud workspace UUID. Used when the caller already knows it (dashboard flows, internal RPCs). */
  workspaceId?: string | null | undefined;

  /** Slack team id (e.g. "T024BE91L") — what sage reads from webhook envelopes. */
  slackTeamId?: string | null | undefined;

  /** GitHub App installation id — what cloud reads from github App webhooks. */
  githubInstallationId?: string | null | undefined;

  // Future providers add their fields here. Keep each field optional and
  // nullable so callers can pass `undefined` when they don't have it.
};

export type ResolveWorkspaceError =
  | "missing_identifier"
  | "invalid_identifier"
  | "not_found";

export type ResolveWorkspaceSuccess = {
  ok: true;
  /** Canonical workspace UUID to use for rate-limiting, audit, downstream lookups. */
  workspaceId: string;
  /** The underlying workspace_integrations record that matched. */
  integration: WorkspaceIntegrationRecord;
  /** How the workspace was resolved — useful for audit entries and migration tracking. */
  resolvedVia:
    | "uuid"
    | "slack-team-id"
    | "github-installation-id";
};

export type ResolveWorkspaceFailure = {
  ok: false;
  error: ResolveWorkspaceError;
  /** Human-readable reason suitable for a 4xx error body. Never contains PII. */
  reason: string;
};

export type ResolveWorkspaceResult =
  | ResolveWorkspaceSuccess
  | ResolveWorkspaceFailure;

type ResolveWorkspaceOptions = {
  /**
   * The provider namespace the proxy route belongs to. Used for:
   *   1. Scoping the UUID fast-path lookup to rows where provider matches
   *      (so a `workspaceId` UUID belonging to a github integration can't
   *      authenticate a slack proxy call and vice versa).
   *   2. Picking the right `findSlackIntegrationByTeamId` vs.
   *      `findWorkspaceIntegrationByInstallation` helper.
   *
   * For slack, pass the specific provider variant (e.g. "slack") — the
   * slack-specific finder does a cross-slack-provider search via metadata,
   * so an exact match isn't required, but the caller should still hint at
   * its native provider so audit rows are honest.
   */
  provider: WorkspaceIntegrationProvider;
};

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve a workspace identity from any combination of external identifiers.
 *
 * Order of operations (fail fast, never scan across providers):
 *   1. If `workspaceId` is a valid UUID → direct `getWorkspaceIntegration`
 *      lookup for the requested provider. Returns success if a row exists.
 *   2. If `slackTeamId` is present AND shaped like a Slack team id → call
 *      `findSlackIntegrationByTeamId`. Used by sage's slack webhook flow.
 *   3. If `githubInstallationId` is present → call
 *      `findWorkspaceIntegrationByInstallation("github-sage", installationId)`.
 *   4. If no identifier was provided → return `missing_identifier`.
 *   5. If an identifier was provided but didn't resolve → return `not_found`.
 *
 * Never throws; always returns a discriminated union so callers can
 * pattern-match and emit audit entries.
 */
export async function resolveWorkspace(
  input: ResolveWorkspaceInput,
  options: ResolveWorkspaceOptions,
): Promise<ResolveWorkspaceResult> {
  const workspaceIdCandidate = trimOrNull(input.workspaceId);
  const slackTeamIdCandidate = trimOrNull(input.slackTeamId);
  const githubInstallationIdCandidate = trimOrNull(input.githubInstallationId);

  // Fast path: caller already has a workspace id (UUID or `rw_<8hex>`).
  // Always preferred over provider-scoped identifiers because it's a
  // single-row lookup and doesn't touch metadata_json.
  if (workspaceIdCandidate) {
    if (!looksLikeWorkspaceId(workspaceIdCandidate)) {
      return {
        ok: false,
        error: "invalid_identifier",
        reason: "workspaceId must be a UUID or rw_<8hex>",
      };
    }

    const integration = await getWorkspaceIntegration(
      workspaceIdCandidate,
      options.provider,
    );

    if (integration) {
      return {
        ok: true,
        workspaceId: integration.workspaceId,
        integration,
        resolvedVia: "uuid",
      };
    }

    // Caller explicitly passed a workspace id but there's no matching
    // row — do NOT fall through to slackTeamId. The caller named a
    // specific workspace and it doesn't exist; reporting that directly
    // is more honest than silently resolving to a different workspace
    // via a provider-scoped lookup.
    return {
      ok: false,
      error: "not_found",
      reason: `No ${options.provider} integration found for workspace ${workspaceIdCandidate}`,
    };
  }

  // Provider-scoped lookups. Only one runs per call — we don't scan
  // across provider types even if the caller sent multiple identifiers.
  if (slackTeamIdCandidate) {
    if (!looksLikeSlackTeamId(slackTeamIdCandidate)) {
      return {
        ok: false,
        error: "invalid_identifier",
        reason: "slackTeamId does not match Slack's team id format",
      };
    }

    const integration = await findSlackIntegrationByTeamId(
      slackTeamIdCandidate,
    );

    if (integration) {
      return {
        ok: true,
        workspaceId: integration.workspaceId,
        integration,
        resolvedVia: "slack-team-id",
      };
    }

    return {
      ok: false,
      error: "not_found",
      reason: `No slack integration found for team ${slackTeamIdCandidate}`,
    };
  }

  if (githubInstallationIdCandidate) {
    const integration = await findWorkspaceIntegrationByInstallation(
      "github",
      githubInstallationIdCandidate,
    );

    if (integration) {
      return {
        ok: true,
        workspaceId: integration.workspaceId,
        integration,
        resolvedVia: "github-installation-id",
      };
    }

    return {
      ok: false,
      error: "not_found",
      reason: `No github integration found for installation ${githubInstallationIdCandidate}`,
    };
  }

  return {
    ok: false,
    error: "missing_identifier",
    reason:
      "Request must include at least one workspace identifier (workspaceId, slackTeamId, or githubInstallationId)",
  };
}
