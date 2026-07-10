import { describe, expect, it } from "vitest";
import {
  getAllowedBackends,
  getBackendIntegrationId,
  getDefaultBackend,
  getDefaultIntegrationBackend,
  getProviderAliasNames,
  getProviderConfigKey,
  isBackendAllowedForProvider,
  isWorkspaceIntegrationProvider,
  listWorkspaceIntegrationCatalogEntries,
  resolveWorkspaceIntegrationProvider,
  WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS,
  WORKSPACE_INTEGRATION_PROVIDERS,
  type WorkspaceIntegrationProvider,
} from "./providers";

const EXPECTED_PROVIDER_CONFIG_KEYS = {
  github: "github-relay",
  gitlab: "gitlab-relay",
  x: "x-relay",
  slack: "slack-relay",
  telegram: "telegram-relay",
  "slack-ricky": "slack-ricky",
  "slack-my-senior-dev": "slack-my-senior-dev",
  "slack-nightcto": "slack-nightcto",
  notion: "notion-relay",
  hubspot: "hubspot-relay",
  linear: "linear-relay",
  "linear-ricky": "linear-ricky",
  jira: "jira-relay",
  confluence: "confluence-relay",
  "google-mail": "google-mail-relay",
  "google-calendar": "google-calendar-relay",
  granola: "granola-relay",
  fathom: "fathom-relay",
  "docker-hub": "docker_hub-composio-relay",
  reddit: "reddit-composio-relay",
  dropbox: "dropbox-relay",
  daytona: "daytona-relay",
  gcp: "gcp-relay",
  cloudflare: "cloudflare-relay",
  recall: "recall-relay",
  neon: "neon-relay",
} satisfies Record<WorkspaceIntegrationProvider, string>;

describe("workspace integration provider catalog", () => {
  it("keeps the legacy Nango config key for every provider", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      expect(getProviderConfigKey(provider)).toBe(
        EXPECTED_PROVIDER_CONFIG_KEYS[provider],
      );
    }
  });

  it("exposes top-level backend and backendIntegrationId on every definition row", () => {
    for (const definition of WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS) {
      expect(definition.backend).toBe("nango");
      expect(definition.backendIntegrationId).toBe(definition.defaultConfigKey);
    }
  });

  it("mirrors the legacy config key into each provider's Nango backend entry", () => {
    for (const definition of WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS) {
      expect(definition.defaultBackend).toBe("nango");
      expect(definition.backends.nango?.backendIntegrationId).toBe(
        definition.defaultConfigKey,
      );
      if (definition.id === "github") {
        expect(definition.backends.composio?.backendIntegrationId).toBe("github");
      } else {
        expect(definition.backends.composio).toBeUndefined();
      }
    }
  });

  it("resolves the default backend integration id to the Nango mirror", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      expect(getBackendIntegrationId(provider)).toBe(
        EXPECTED_PROVIDER_CONFIG_KEYS[provider],
      );
      expect(getBackendIntegrationId(provider, "nango")).toBe(
        getProviderConfigKey(provider),
      );
    }
  });

  it("returns null for cross-backend miss instead of throwing", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      if (provider === "github") {
        expect(getBackendIntegrationId(provider, "composio")).toBe("github");
      } else {
        expect(getBackendIntegrationId(provider, "composio")).toBeNull();
      }
    }
  });

  it("lists enabled backends and checks backend allow-list policy", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      const allowedBackends = getAllowedBackends(provider);

      expect(allowedBackends).toEqual(
        provider === "github" ? ["nango", "composio"] : ["nango"],
      );
      expect(isBackendAllowedForProvider(provider, "nango")).toBe(true);
      expect(isBackendAllowedForProvider(provider, "composio")).toBe(
        provider === "github",
      );
    }
  });

  it("defaults every provider to Nango via getDefaultIntegrationBackend", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      expect(getDefaultIntegrationBackend(provider)).toBe("nango");
    }
    expect(getDefaultIntegrationBackend("notion")).toBe("nango");
  });

  it("keeps getDefaultBackend as a backwards-compat alias of getDefaultIntegrationBackend", () => {
    for (const provider of WORKSPACE_INTEGRATION_PROVIDERS) {
      expect(getDefaultBackend(provider)).toBe(
        getDefaultIntegrationBackend(provider),
      );
    }
  });

  it("exposes the new fields through listWorkspaceIntegrationCatalogEntries()", () => {
    const entries = listWorkspaceIntegrationCatalogEntries();
    expect(entries).toHaveLength(WORKSPACE_INTEGRATION_PROVIDER_DEFINITIONS.length);
    for (const entry of entries) {
      expect(entry.backend).toBe("nango");
      expect(entry.backendIntegrationId).toBe(entry.defaultConfigKey);
      expect(entry.defaultBackend).toBe("nango");
      expect(entry.backends.nango?.backendIntegrationId).toBe(
        entry.defaultConfigKey,
      );
      if (entry.id === "github") {
        expect(entry.backends.composio?.backendIntegrationId).toBe("github");
      } else {
        expect(entry.backends.composio).toBeUndefined();
      }
    }
  });

  it("keeps the slack-sage legacy provider alias resolving to slack", () => {
    expect(resolveWorkspaceIntegrationProvider("slack-sage")).toBe("slack");
  });

  it("keeps the twitter legacy provider alias resolving to x", () => {
    expect(resolveWorkspaceIntegrationProvider("twitter")).toBe("x");
  });

  it("distinguishes provider ids from provider config keys", () => {
    expect(isWorkspaceIntegrationProvider("github")).toBe(true);
    expect(isWorkspaceIntegrationProvider("github-relay")).toBe(false);
  });

  // cloud#1327 — semantic provider name on the persona side must resolve to
  // whichever specific adapter is connected on the workspace side.
  it("resolves github-app-oauth and github-app to github (cloud#1327)", () => {
    expect(resolveWorkspaceIntegrationProvider("github-app-oauth")).toBe("github");
    expect(resolveWorkspaceIntegrationProvider("github-app")).toBe("github");
  });

  it("resolves gmail to google-mail (matches the [[project_gmail_triggers_pr119]] precedent)", () => {
    expect(resolveWorkspaceIntegrationProvider("gmail")).toBe("google-mail");
  });
});

describe("getProviderAliasNames", () => {
  it("returns the canonical id plus every declared alias", () => {
    const names = getProviderAliasNames("github");
    expect(names).toContain("github");
    expect(names).toContain("github-sage");
    expect(names).toContain("github-app-oauth");
    expect(names).toContain("github-app");
    // No duplicates.
    expect(new Set(names).size).toBe(names.length);
  });

  it("returns the same set whether queried by canonical id or an alias", () => {
    const byCanonical = new Set(getProviderAliasNames("github"));
    const byAlias = new Set(getProviderAliasNames("github-app-oauth"));
    expect(byCanonical).toEqual(byAlias);
  });

  it("includes gmail in the google-mail alias set", () => {
    const names = getProviderAliasNames("google-mail");
    expect(names).toContain("google-mail");
    expect(names).toContain("gmail");
  });

  it("falls back to the raw lowercased name for unknown providers without inventing aliases", () => {
    expect(getProviderAliasNames("never-heard-of-this")).toEqual([
      "never-heard-of-this",
    ]);
  });

  it("returns an empty list for an empty/whitespace input", () => {
    expect(getProviderAliasNames("")).toEqual([]);
    expect(getProviderAliasNames("   ")).toEqual([]);
  });
});
