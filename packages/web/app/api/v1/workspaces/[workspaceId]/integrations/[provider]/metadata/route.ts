import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
  hasWorkspaceAccess,
} from "@/lib/integrations/integration-route-handler";
import {
  getNangoClient,
  getNangoSecretKey,
  getProviderConfigKey,
  triggerNangoSyncs,
} from "@/lib/integrations/nango-service";
import {
  isWorkspaceIntegrationProvider,
  resolveWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  getWorkspaceIntegration,
  upsertWorkspaceIntegration,
} from "@/lib/integrations/workspace-integrations";

// Operator-controlled mutation of the Nango connection metadata namespace
// for a given workspace + provider. The motivating case is Jira / Confluence
// where the operator picks a `cloudId` after OAuth completes (see the
// sibling `accessible-resources` route), but this verb is intentionally
// general-purpose so any operator-supplied connection-level setting (e.g.
// linear `team_id`, a non-default API host, etc.) can be set via SDK/CLI
// without poking the Nango dashboard.
//
// We use `setMetadata` (full replacement, not merge) because metadata
// payloads are small flat-ish records, the operator is typically writing
// the whole object they want to live there, and full-replacement makes the
// CLI confirmation step ("you're about to set metadata to X") truthful.
// Callers that want merge semantics can read the connection first.

type RouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type SuccessBody = {
  ok: true;
  metadata: Record<string, unknown>;
};

type ErrorBody = {
  ok: false;
  error: string;
  code?: string;
};

type PutRequestBody = {
  metadata?: unknown;
};

type GitLabSetupProjectWebhooksResult = {
  webhookSubscriptions?: unknown;
};

const REDDIT_DEFAULT_SUBREDDITS = ["tech", "claudecode", "ai_agents"] as const;
const REDDIT_SYNC_NAMES = [
  "fetch-subreddits",
  "fetch-posts",
  "fetch-hot-posts",
  "fetch-rising-posts",
  "fetch-top-posts",
  "fetch-best-posts",
] as const;

function normalizeRedditSubreddits(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const normalized = item.trim().replace(/^r\//i, "").toLowerCase();
    if (!normalized) {
      return null;
    }
    names.push(normalized);
  }
  return Array.from(new Set(names));
}

// Reject keys that look like Nango-internal plumbing. We keep the deny-list
// conservative: anything operator-supplied that starts with `_` or matches
// the canonical Nango connection / auth fields. Custom domain-specific keys
// (cloudId, baseUrl, team_id, ...) are intentionally allowed.
const NANGO_RESERVED_KEY_PATTERNS: RegExp[] = [
  /^_/,
  /^connection_/i,
  /^auth_/i,
  /^provider_config_key$/i,
  /^connection_id$/i,
  /^connectionconfig$/i,
];

function isReservedKey(key: string): boolean {
  if (key.length === 0) {
    return true;
  }
  return NANGO_RESERVED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function errorResponse(
  status: number,
  body: { code: string; message: string },
): NextResponse<ErrorBody> {
  return NextResponse.json<ErrorBody>(
    { ok: false, error: body.message, code: body.code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeGitLabProjectIds(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" && typeof item !== "number") {
      return null;
    }
    const id = String(item).trim();
    if (!id) {
      return null;
    }
    ids.push(id);
  }
  return ids;
}

function normalizeGitLabProjectObjectIds(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: string[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      return null;
    }
    const rawId = item.id;
    if (typeof rawId !== "string" && typeof rawId !== "number") {
      return null;
    }
    const id = String(rawId).trim();
    if (!id) {
      return null;
    }
    ids.push(id);
  }
  return ids;
}

// Lenient validation: scalars + nested objects + arrays of scalars/objects.
// Reject functions, symbols, etc. — they round-trip badly through JSON
// anyway. We don't bother enforcing a fixed key-set because operators are
// free to set domain-specific keys.
function validateMetadataValue(value: unknown, depth = 0): string | null {
  if (depth > 10) {
    return "metadata nesting depth exceeds 10";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const err = validateMetadataValue(entry, depth + 1);
      if (err) {
        return err;
      }
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (depth === 0 && isReservedKey(key)) {
        return `metadata key "${key}" is reserved by the Nango backend`;
      }
      const err = validateMetadataValue(entry, depth + 1);
      if (err) {
        return err;
      }
    }
    return null;
  }
  return "metadata contains a non-JSON-serializable value";
}

function gitLabHookdeckWebhookUrl(): string {
  return `${getConfiguredAppOrigin().replace(/\/+$/, "")}/api/v1/webhooks/hookdeck`;
}

function generateGitLabWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function readMetadataObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function readConnectionMetadata(connection: unknown): Record<string, unknown> {
  if (!connection || typeof connection !== "object" || !("metadata" in connection)) {
    return {};
  }
  return readMetadataObject((connection as { metadata?: unknown }).metadata);
}

function redactSensitiveMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveMetadata);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = /secret|token/i.test(key)
      ? "[redacted]"
      : redactSensitiveMetadata(entry);
  }
  return out;
}

function safeResponseMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitiveMetadata(metadata);
  return isPlainObject(redacted) ? redacted : {};
}

function resolveRedditSubredditsOrDefault(subreddits: string[] | undefined): string[] {
  return subreddits && subreddits.length > 0
    ? subreddits
    : [...REDDIT_DEFAULT_SUBREDDITS];
}

async function resolveIntegrationForRequest(
  request: NextRequest,
  context: RouteContext,
  options?: { controlScope?: string },
):
  Promise<
    | {
        ok: true;
        workspaceId: string;
        provider: WorkspaceIntegrationProvider;
        integration: NonNullable<Awaited<ReturnType<typeof getWorkspaceIntegration>>>;
      }
    | { ok: false; response: NextResponse<ErrorBody> }
  > {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;

  if (!auth) {
    return {
      ok: false,
      response: errorResponse(401, {
        code: "unauthorized",
        message: "Unauthorized",
      }),
    };
  }
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return {
      ok: false,
      response: errorResponse(403, { code: "forbidden", message: "Forbidden" }),
    };
  }
  if (options?.controlScope && !hasCloudControlScope(auth, options.controlScope)) {
    return {
      ok: false,
      response: errorResponse(403, { code: "forbidden", message: "Forbidden" }),
    };
  }

  const resolved = resolveWorkspaceIntegrationProvider(provider);
  if (!resolved || !isWorkspaceIntegrationProvider(resolved)) {
    return {
      ok: false,
      response: errorResponse(404, {
        code: "unknown_provider",
        message: "Integration provider not found",
      }),
    };
  }

  if (!getNangoSecretKey()) {
    return {
      ok: false,
      response: errorResponse(501, {
        code: "backend_not_configured",
        message: "Nango backend not configured",
      }),
    };
  }

  const integration = await getWorkspaceIntegration(workspaceId, resolved);
  if (!integration) {
    return {
      ok: false,
      response: errorResponse(404, {
        code: "integration_not_found",
        message: `No ${resolved} integration is connected for this workspace`,
      }),
    };
  }

  return { ok: true, workspaceId, provider: resolved, integration };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const resolved = await resolveIntegrationForRequest(request, context);
  if (!resolved.ok) {
    return resolved.response;
  }

  try {
    const nango = getNangoClient();
    const providerConfigKey =
      resolved.integration.providerConfigKey ??
      getProviderConfigKey(resolved.provider);
    const connection = await nango.getConnection(
      providerConfigKey,
      resolved.integration.connectionId,
    );
    const metadata =
      connection && typeof connection === "object" && "metadata" in connection
        ? ((connection as { metadata?: unknown }).metadata ?? {})
        : {};
    const safeMetadata = isPlainObject(metadata) ? safeResponseMetadata(metadata) : {};
    if (resolved.provider === "reddit") {
      const normalizedSubreddits = normalizeRedditSubreddits(safeMetadata.subreddits);
      if (normalizedSubreddits === null) {
        return NextResponse.json<SuccessBody>(
          {
            ok: true,
            metadata: {
              ...safeMetadata,
              subreddits: [...REDDIT_DEFAULT_SUBREDDITS],
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json<SuccessBody>(
        {
          ok: true,
          metadata: {
            ...safeMetadata,
            subreddits: resolveRedditSubredditsOrDefault(normalizedSubreddits),
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json<SuccessBody>(
      { ok: true, metadata: safeMetadata },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Integration metadata read failed:", {
      workspaceId: resolved.workspaceId,
      provider: resolved.provider,
      error: message,
    });
    return errorResponse(502, {
      code: "upstream_error",
      message: `Failed to read metadata for ${resolved.provider}: ${message}`,
    });
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, {
      code: "invalid_body",
      message: "Invalid JSON body",
    });
  }

  const body: PutRequestBody =
    rawBody && typeof rawBody === "object" ? (rawBody as PutRequestBody) : {};

  if (!isPlainObject(body.metadata)) {
    return errorResponse(400, {
      code: "invalid_body",
      message: "Body must be an object of the form { metadata: { ... } }",
    });
  }

  const metadata = body.metadata;
  const validationError = validateMetadataValue(metadata);
  if (validationError) {
    return errorResponse(400, {
      code: "invalid_metadata",
      message: validationError,
    });
  }

  const resolved = await resolveIntegrationForRequest(request, context, {
    controlScope: CLOUD_INTEGRATIONS_WRITE_SCOPE,
  });
  if (!resolved.ok) {
    return resolved.response;
  }

  try {
    const nango = getNangoClient();
    const providerConfigKey =
      resolved.integration.providerConfigKey ??
      getProviderConfigKey(resolved.provider);
    let metadataToSave = metadata;
    let gitLabSetupResult: GitLabSetupProjectWebhooksResult | null = null;
    let selectedGitLabProjectIds: string[] = [];
    let projectIdsForGitLabSetup: string[] | undefined;
    let selectedRedditSubreddits: string[] | undefined;
    if (resolved.provider === "gitlab") {
      const connection = await nango.getConnection(
        providerConfigKey,
        resolved.integration.connectionId,
      );
      const existingMetadata = readConnectionMetadata(connection);
      const projectIds = normalizeGitLabProjectIds(
        metadata.projectIds === undefined ? existingMetadata.projectIds : metadata.projectIds,
      );
      const projectIdsFromProjects = normalizeGitLabProjectObjectIds(
        metadata.projects === undefined ? existingMetadata.projects : metadata.projects,
      );
      if (projectIds === null) {
        return errorResponse(400, {
          code: "invalid_metadata",
          message: "GitLab projectIds must be an array of non-empty string or number IDs.",
        });
      }
      if (projectIdsFromProjects === null) {
        return errorResponse(400, {
          code: "invalid_metadata",
          message: "GitLab projects must be an array of objects with non-empty string or number id fields.",
        });
      }
      selectedGitLabProjectIds = [
        ...new Set([...(projectIds ?? []), ...(projectIdsFromProjects ?? [])]),
      ];
      projectIdsForGitLabSetup =
        selectedGitLabProjectIds.length > 0 ? selectedGitLabProjectIds : undefined;
      metadataToSave = {
        ...existingMetadata,
        ...metadata,
        ...(projectIds ? { projectIds } : {}),
        webhookUrl:
          readNonEmptyString(metadata.webhookUrl) ??
          readNonEmptyString(existingMetadata.webhookUrl) ??
          gitLabHookdeckWebhookUrl(),
        webhookSecret:
          readNonEmptyString(metadata.webhookSecret) ??
          readNonEmptyString(existingMetadata.webhookSecret) ??
          generateGitLabWebhookSecret(),
      };
    } else if (resolved.provider === "reddit") {
      const connection = await nango.getConnection(
        providerConfigKey,
        resolved.integration.connectionId,
      );
      const existingMetadata = readConnectionMetadata(connection);
      const normalizedSubreddits = normalizeRedditSubreddits(
        metadata.subreddits === undefined ? existingMetadata.subreddits : metadata.subreddits,
      );
      if (normalizedSubreddits === null) {
        return errorResponse(400, {
          code: "invalid_metadata",
          message: "Reddit subreddits must be an array of non-empty subreddit names.",
        });
      }
      selectedRedditSubreddits = resolveRedditSubredditsOrDefault(normalizedSubreddits);
      metadataToSave = {
        ...existingMetadata,
        ...metadata,
        subreddits: selectedRedditSubreddits,
      };
    } else if (resolved.provider === "daytona") {
      const connection = await nango.getConnection(
        providerConfigKey,
        resolved.integration.connectionId,
      );
      const existingMetadata = readConnectionMetadata(connection);
      const organizationId =
        readNonEmptyString(metadata.organizationId) ??
        readNonEmptyString(metadata.organization_id) ??
        readNonEmptyString(existingMetadata.organizationId) ??
        readNonEmptyString(existingMetadata.organization_id);
      if (!organizationId) {
        return errorResponse(400, {
          code: "invalid_metadata",
          message: "Daytona organizationId is required.",
        });
      }
      metadataToSave = {
        ...existingMetadata,
        ...metadata,
        organizationId,
      };
    } else if (resolved.provider === "gcp" || resolved.provider === "cloudflare") {
      const connection = await nango.getConnection(
        providerConfigKey,
        resolved.integration.connectionId,
      );
      const existingMetadata = readConnectionMetadata(connection);
      const webhookUrl =
        readNonEmptyString(metadata.webhookUrl) ??
        readNonEmptyString(existingMetadata.webhookUrl);
      if (!webhookUrl) {
        return errorResponse(400, {
          code: "invalid_metadata",
          message: `${resolved.provider} metadata.webhookUrl is required and must be the external Hookdeck source URL.`,
        });
      }
      // gcp-relay and cloudflare-relay deliver provider notifications through
      // an external Hookdeck source URL. Store it on the connection so
      // setup-webhooks always targets the real provider-facing ingress instead
      // of a Nango-managed or Cloud-internal webhook path.
      metadataToSave = {
        ...existingMetadata,
        ...metadata,
        webhookUrl,
      };
    }
    await nango.setMetadata(
      providerConfigKey,
      resolved.integration.connectionId,
      metadataToSave,
    );
    if (resolved.provider === "gitlab") {
      gitLabSetupResult = await nango.triggerAction(
        providerConfigKey,
        resolved.integration.connectionId,
        "setup-project-webhooks",
        {
          projectIds: projectIdsForGitLabSetup,
          webhookUrl: metadataToSave.webhookUrl,
          webhookSecret: metadataToSave.webhookSecret,
        },
      ) as GitLabSetupProjectWebhooksResult;
      const localMetadata = {
        ...metadataToSave,
        ...(Array.isArray(gitLabSetupResult.webhookSubscriptions)
          ? { webhookSubscriptions: gitLabSetupResult.webhookSubscriptions }
          : {}),
      };
      await upsertWorkspaceIntegration({
        workspaceId: resolved.workspaceId,
        provider: resolved.provider,
        connectionId: resolved.integration.connectionId,
        providerConfigKey,
        installationId: resolved.integration.installationId,
        metadata: localMetadata,
      });
      if (selectedGitLabProjectIds.length > 0) {
        const syncResult = await triggerNangoSyncs({
          providerConfigKey,
          connectionId: resolved.integration.connectionId,
          syncs: [
            "fetch-merge-requests",
            "fetch-issues",
            "fetch-commits",
            "fetch-pipelines",
            "fetch-deployments",
            "fetch-tags",
          ],
          syncMode: "incremental",
        });
        if (!syncResult.ok) {
          throw new Error(`Failed to trigger GitLab selected-project syncs: ${syncResult.status}`);
        }
      }
    } else if (resolved.provider === "reddit" && selectedRedditSubreddits && selectedRedditSubreddits.length > 0) {
      const syncResult = await triggerNangoSyncs({
        providerConfigKey,
        connectionId: resolved.integration.connectionId,
        syncs: [...REDDIT_SYNC_NAMES],
        syncMode: "incremental",
      });
      if (!syncResult.ok) {
        throw new Error(`Failed to trigger Reddit syncs: ${syncResult.status}`);
      }
    } else if (resolved.provider === "daytona") {
      await nango.triggerAction(
        providerConfigKey,
        resolved.integration.connectionId,
        "setup-webhooks",
      );
      await upsertWorkspaceIntegration({
        workspaceId: resolved.workspaceId,
        provider: resolved.provider,
        connectionId: resolved.integration.connectionId,
        providerConfigKey,
        installationId: resolved.integration.installationId,
        metadata: metadataToSave,
      });
    } else if (resolved.provider === "gcp" || resolved.provider === "cloudflare") {
      // Provision provider-managed delivery targeting the Hookdeck URL we just
      // stored. Both gcp-relay and cloudflare-relay honor input.webhookUrl, so
      // setup never depends on a Nango-managed webhook URL.
      await nango.triggerAction(
        providerConfigKey,
        resolved.integration.connectionId,
        "setup-webhooks",
        { webhookUrl: metadataToSave.webhookUrl },
      );
      await upsertWorkspaceIntegration({
        workspaceId: resolved.workspaceId,
        provider: resolved.provider,
        connectionId: resolved.integration.connectionId,
        providerConfigKey,
        installationId: resolved.integration.installationId,
        metadata: metadataToSave,
      });
    }
    return NextResponse.json<SuccessBody>(
      { ok: true, metadata: safeResponseMetadata(metadataToSave) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Integration metadata update failed:", {
      workspaceId: resolved.workspaceId,
      provider: resolved.provider,
      error: message,
    });
    return errorResponse(502, {
      code: "upstream_error",
      message: `Failed to update metadata for ${resolved.provider}: ${message}`,
    });
  }
}
