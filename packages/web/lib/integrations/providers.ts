// Provider naming convention: relayfile integrations are `<integration>-relay`
// (e.g. `github-relay`, `notion-relay`, `linear-relay`, `slack-relay`). The
// older `<integration>-sage` keys are retained as aliases only where legacy
// product surfaces still require them.
//
// Each entry carries backend-neutral metadata for the control-plane registry:
//   - `backend`              - the default IntegrationBackend for the provider
//                              (canonical top-level field).
//   - `backendIntegrationId` - the backend-neutral integration id used by the
//                              runtime registry. Mirrors `defaultConfigKey`
//                              for every row today.
//   - `defaultBackend`       - alias of `backend` retained for sibling slices
//                              that already imported the older field name.
//   - `backends`             - per-backend lookup map. Nango mirrors the
//                              legacy `defaultConfigKey`; Composio entries use
//                              the toolkit slug consumed by Composio auth
//                              config discovery.
// `defaultConfigKey` remains the Nango-specific legacy alias for callers that
// still speak in provider config keys.
//
// The slack relayfile integration was historically keyed `slack-sage` to
// match its original Nango config-key. The Nango config-key was renamed to
// `slack-relay` and the workspace_integrations rows / internal id are
// migrated to `slack`, with `slack-sage` retained as an alias indefinitely
// so any in-flight tokens, external integrations, or legacy webhooks
// referencing `slack-sage` continue to resolve.
//
// `slack-my-senior-dev`, `slack-nightcto`, `slack-ricky`, and `linear-ricky`
// are *separate* product apps, not relayfile integrations, and intentionally
// keep their names.

// TODO(provider-contracts): replace with an import from
// @relayfile/provider-contracts once that shared package is published.
export type IntegrationBackend = "nango" | "composio";

export interface ProviderBackendCatalogEntry {
  backendIntegrationId: string;
  backendMetadata?: Readonly<Record<string, unknown>>;
}

type ProviderBackendCatalog = Readonly<
  Record<IntegrationBackend, ProviderBackendCatalogEntry | undefined>
>;

type WorkspaceIntegrationProviderDefinitionShape = {
  id: string;
  displayName: string;
  /** Nango-specific legacy alias for the Nango backendIntegrationId. */
  defaultConfigKey: string;
  vfsRoot: string;
  aliases: readonly string[];
  deprecated: boolean;
  /** Canonical default IntegrationBackend for the provider. */
  backend: IntegrationBackend;
  /** Backend-neutral integration id (mirror of `defaultConfigKey` today). */
  backendIntegrationId: string;
  /** Compat alias of `backend` retained for sibling slices. */
  defaultBackend: IntegrationBackend;
  /**
   * Per-backend lookup map used by the runtime registry helpers. The default
   * backend's entry mirrors `defaultConfigKey`. Other backends are `undefined`
   * until a workspace policy opts a provider into them.
   */
  backends: ProviderBackendCatalog;
};

const INTEGRATION_BACKENDS = ["nango", "composio"] as const;

export const WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS = [
  {
    id: "github",
    displayName: "GitHub",
    defaultConfigKey: "github-relay",
    vfsRoot: "/github",
    // `github-app-oauth` and `github-app` are the workspace-side adapter
    // names for the GitHub App OAuth flow; persona authors and the rest of
    // cloud refer to it semantically as "github". Aliases keep the deploy
    // path from 400ing when the persona writes `integrations.github` while
    // the workspace has the `github-app-oauth` Nango config connected.
    aliases: ["github-sage", "github-app-oauth", "github-app"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "github-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "github-relay" },
      composio: { backendIntegrationId: "github" },
    },
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    defaultConfigKey: "gitlab-relay",
    vfsRoot: "/gitlab",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "gitlab-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "gitlab-relay" },
      composio: undefined,
    },
  },
  {
    id: "hubspot",
    displayName: "HubSpot",
    defaultConfigKey: "hubspot-relay",
    vfsRoot: "/hubspot",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "hubspot-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "hubspot-relay" },
      composio: undefined,
    },
  },
  {
    id: "x",
    displayName: "X",
    defaultConfigKey: "x-relay",
    vfsRoot: "/x",
    aliases: ["twitter"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "x-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "x-relay" },
      composio: undefined,
    },
  },
  {
    // The internal provider id is `slack`; `slack-sage` is the legacy id
    // retained as an alias for backwards-compat (in-flight Nango tokens,
    // external integrations, and any consumers still referencing the old
    // id). The Nango config-key is `slack-relay`.
    id: "slack",
    displayName: "Slack",
    defaultConfigKey: "slack-relay",
    vfsRoot: "/slack",
    aliases: ["slack-sage", "slack-sage-preview"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "slack-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "slack-relay" },
      composio: undefined,
    },
  },
  {
    id: "telegram",
    displayName: "Telegram",
    defaultConfigKey: "telegram-relay",
    vfsRoot: "/telegram",
    aliases: ["telegram-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "telegram-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "telegram-relay" },
      composio: undefined,
    },
  },
  {
    id: "slack-ricky",
    displayName: "Slack (Ricky)",
    defaultConfigKey: "slack-ricky",
    vfsRoot: "/slack-ricky",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "slack-ricky",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "slack-ricky" },
      composio: undefined,
    },
  },
  {
    id: "slack-my-senior-dev",
    displayName: "Slack (MSD)",
    defaultConfigKey: "slack-my-senior-dev",
    vfsRoot: "/slack-msd",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "slack-my-senior-dev",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "slack-my-senior-dev" },
      composio: undefined,
    },
  },
  {
    id: "slack-nightcto",
    displayName: "Slack (NightCTO)",
    defaultConfigKey: "slack-nightcto",
    vfsRoot: "/slack-nightcto",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "slack-nightcto",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "slack-nightcto" },
      composio: undefined,
    },
  },
  {
    id: "notion",
    displayName: "Notion",
    defaultConfigKey: "notion-relay",
    vfsRoot: "/notion",
    aliases: ["notion-sage"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "notion-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "notion-relay" },
      composio: undefined,
    },
  },
  {
    id: "linear",
    displayName: "Linear",
    defaultConfigKey: "linear-relay",
    vfsRoot: "/linear",
    aliases: ["linear-sage"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "linear-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "linear-relay" },
      composio: undefined,
    },
  },
  {
    id: "linear-ricky",
    displayName: "Linear (Ricky)",
    defaultConfigKey: "linear-ricky",
    vfsRoot: "/linear-ricky",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "linear-ricky",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "linear-ricky" },
      composio: undefined,
    },
  },
  {
    id: "jira",
    displayName: "Jira",
    defaultConfigKey: "jira-relay",
    vfsRoot: "/jira",
    aliases: ["jira-sage"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "jira-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "jira-relay" },
      composio: undefined,
    },
  },
  {
    id: "confluence",
    displayName: "Confluence",
    defaultConfigKey: "confluence-relay",
    vfsRoot: "/confluence",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "confluence-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "confluence-relay" },
      composio: undefined,
    },
  },
  {
    id: "google-mail",
    displayName: "Google Mail",
    defaultConfigKey: "google-mail-relay",
    vfsRoot: "/google-mail",
    // `gmail` is the colloquial name persona authors reach for first; the
    // cloud-side connect provider id is `google-mail` (see
    // [[project_gmail_triggers_pr119]] memory). Aliasing avoids the 409 on
    // connect-by-slug and lets personas declare either name.
    aliases: ["google-mail-relay", "gmail"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "google-mail-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "google-mail-relay" },
      composio: undefined,
    },
  },
  {
    id: "google-calendar",
    displayName: "Google Calendar",
    defaultConfigKey: "google-calendar-relay",
    vfsRoot: "/google-calendar",
    aliases: ["google-calendar-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "google-calendar-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "google-calendar-relay" },
      composio: undefined,
    },
  },
  {
    id: "granola",
    displayName: "Granola",
    defaultConfigKey: "granola-relay",
    vfsRoot: "/granola",
    aliases: ["granola-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "granola-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "granola-relay" },
      composio: undefined,
    },
  },
  {
    id: "fathom",
    displayName: "Fathom",
    defaultConfigKey: "fathom-relay",
    vfsRoot: "/fathom",
    aliases: ["fathom-relay", "fathom-oauth"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "fathom-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "fathom-relay" },
      composio: undefined,
    },
  },
  {
    id: "docker-hub",
    displayName: "Docker Hub",
    defaultConfigKey: "docker_hub-composio-relay",
    vfsRoot: "/docker-hub",
    aliases: ["docker-hub-composio-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "docker_hub-composio-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "docker_hub-composio-relay" },
      composio: undefined,
    },
  },
  {
    id: "reddit",
    displayName: "Reddit",
    defaultConfigKey: "reddit-composio-relay",
    vfsRoot: "/reddit",
    aliases: ["reddit-composio-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "reddit-composio-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "reddit-composio-relay" },
      composio: undefined,
    },
  },
  {
    id: "dropbox",
    displayName: "Dropbox",
    defaultConfigKey: "dropbox-relay",
    vfsRoot: "/dropbox",
    aliases: ["dropbox"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "dropbox-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "dropbox-relay" },
      composio: undefined,
    },
  },
  {
    id: "daytona",
    displayName: "Daytona",
    defaultConfigKey: "daytona-relay",
    vfsRoot: "/daytona",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "daytona-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "daytona-relay" },
      composio: undefined,
    },
  },
  {
    id: "gcp",
    displayName: "GCP",
    defaultConfigKey: "gcp-relay",
    vfsRoot: "/gcp",
    aliases: [] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "gcp-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "gcp-relay" },
      composio: undefined,
    },
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    defaultConfigKey: "cloudflare-relay",
    vfsRoot: "/cloudflare",
    aliases: ["cloudflare-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "cloudflare-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "cloudflare-relay" },
      composio: undefined,
    },
  },
  {
    id: "neon",
    displayName: "Neon",
    defaultConfigKey: "neon-relay",
    vfsRoot: "/neon",
    aliases: ["neon-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "neon-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "neon-relay" },
      composio: undefined,
    },
  },
  {
    id: "recall",
    displayName: "Recall",
    defaultConfigKey: "recall-relay",
    vfsRoot: "/recall",
    aliases: ["recall-relay"] as const,
    deprecated: false,
    backend: "nango",
    backendIntegrationId: "recall-relay",
    defaultBackend: "nango",
    backends: {
      nango: { backendIntegrationId: "recall-relay" },
      composio: undefined,
    },
  },
] as const satisfies readonly WorkspaceIntegrationProviderDefinitionShape[];

export type WorkspaceIntegrationProviderDefinition =
  (typeof WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS)[number];

export type WorkspaceIntegrationProvider =
  (typeof WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS)[number]["id"];

export const WORKSPACE_INTEGRATION_PROVIDERS =
  WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.map((entry) => entry.id) as readonly WorkspaceIntegrationProvider[];

const PROVIDER_BY_ID = new Map<string, WorkspaceIntegrationProviderDefinition>(
  WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.map((entry) => [
    entry.id,
    entry,
  ]),
);

const PROVIDER_BY_ALIAS = new Map<string, WorkspaceIntegrationProvider>(
  WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.flatMap((entry) => [
    [entry.id, entry.id],
    ...((entry.aliases ?? []).map((alias) => [alias, entry.id] as const)),
  ]),
);

export const WORKSPACE_INTEGRATION_LABELS: Record<
  WorkspaceIntegrationProvider,
  string
> = Object.fromEntries(
  WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.map((entry) => [
    entry.id,
    entry.displayName,
  ]),
) as Record<WorkspaceIntegrationProvider, string>;

export function isWorkspaceIntegrationProvider(
  value: string,
): value is WorkspaceIntegrationProvider {
  return PROVIDER_BY_ID.has(value);
}

export function resolveWorkspaceIntegrationProvider(
  value: string | null | undefined,
): WorkspaceIntegrationProvider | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const resolved = PROVIDER_BY_ALIAS.get(normalized);
  return resolved && isWorkspaceIntegrationProvider(resolved) ? resolved : null;
}

export function getWorkspaceIntegrationProviderDefinition(
  provider: WorkspaceIntegrationProvider,
): WorkspaceIntegrationProviderDefinition {
  const definition = PROVIDER_BY_ID.get(provider);
  if (!definition) {
    throw new Error(`Unknown workspace integration provider: ${provider}`);
  }
  return definition;
}

/**
 * Returns all provider-id names that semantically refer to the same
 * workspace integration: the canonical id plus every declared alias. Use
 * this when looking up DB rows / Nango records where the stored provider
 * column may legitimately be either the canonical name or an alias (e.g.
 * a `github-app-oauth` row when the persona refers to `github`).
 */
export function getProviderAliasNames(
  provider: string,
): readonly string[] {
  const canonical = resolveWorkspaceIntegrationProvider(provider);
  if (!canonical) {
    // Unknown provider — preserve caller intent without inventing aliases.
    return provider.trim() ? [provider.trim().toLowerCase()] : [];
  }
  const definition = PROVIDER_BY_ID.get(canonical);
  if (!definition) return [canonical];
  const names = new Set<string>([canonical, ...definition.aliases]);
  return Array.from(names);
}

export function getProviderConfigKey(
  provider: WorkspaceIntegrationProvider,
): string {
  return getWorkspaceIntegrationProviderDefinition(provider).defaultConfigKey;
}

export function getAllowedBackends(
  provider: WorkspaceIntegrationProvider,
): readonly IntegrationBackend[] {
  const definition = getWorkspaceIntegrationProviderDefinition(provider);
  return INTEGRATION_BACKENDS.filter(
    (backend) => definition.backends[backend] !== undefined,
  );
}

export function getDefaultIntegrationBackend(
  provider: WorkspaceIntegrationProvider,
): IntegrationBackend {
  return getWorkspaceIntegrationProviderDefinition(provider).backend;
}

/**
 * Backwards-compat alias of {@link getDefaultIntegrationBackend} retained for
 * sibling slices that already imported the older name.
 */
export function getDefaultBackend(
  provider: WorkspaceIntegrationProvider,
): IntegrationBackend {
  return getDefaultIntegrationBackend(provider);
}

/**
 * Returns the backend-neutral integration id for `provider`. When `backend`
 * is omitted the provider's default backend is used. Returns `null` when the
 * requested backend is not declared for the provider.
 */
export function getBackendIntegrationId(
  provider: WorkspaceIntegrationProvider,
  backend?: IntegrationBackend,
): string | null {
  const definition = getWorkspaceIntegrationProviderDefinition(provider);
  const selectedBackend = backend ?? definition.backend;
  return definition.backends[selectedBackend]?.backendIntegrationId ?? null;
}

export function isBackendAllowedForProvider(
  provider: WorkspaceIntegrationProvider,
  backend: IntegrationBackend,
): boolean {
  return (
    getWorkspaceIntegrationProviderDefinition(provider).backends[backend] !==
    undefined
  );
}

export function listWorkspaceIntegrationCatalogEntries(): WorkspaceIntegrationProviderDefinition[] {
  return WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.map((entry) => ({ ...entry }));
}
