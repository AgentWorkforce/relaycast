import { describe, expect, it } from "vitest";
import {
  getProviderConfigKey,
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
  resolveWorkspaceIntegrationProvider,
} from "../packages/web/lib/integrations/providers";

// These tests pin the slack-sage → slack rename: the canonical provider id
// is now "slack" and "slack-sage" is retained as a backwards-compat alias
// indefinitely so any in-flight tokens or external integrations referencing
// the old id continue to resolve.
describe("workspace integration providers — slack rename", () => {
  it("recognizes 'slack' as a canonical provider id", () => {
    expect(isWorkspaceIntegrationProvider("slack")).toBe(true);
    expect(resolveWorkspaceIntegrationProvider("slack")).toBe("slack");
  });

  it("does NOT recognize 'slack-sage' as a canonical id (it is an alias)", () => {
    expect(isWorkspaceIntegrationProvider("slack-sage")).toBe(false);
  });

  it("resolves the 'slack-sage' alias to the canonical 'slack' provider id", () => {
    expect(resolveWorkspaceIntegrationProvider("slack-sage")).toBe("slack");
  });

  it("resolves the 'slack-sage' alias case-insensitively", () => {
    expect(resolveWorkspaceIntegrationProvider("Slack-Sage")).toBe("slack");
    expect(resolveWorkspaceIntegrationProvider("  slack-sage  ")).toBe("slack");
  });

  it("uses 'slack-relay' as the Nango config key for the slack provider", () => {
    expect(getProviderConfigKey("slack")).toBe("slack-relay");
  });

  it("exposes /slack as the relayfile vfs root for the slack provider", () => {
    const definition = getWorkspaceIntegrationProviderDefinition("slack");
    expect(definition.vfsRoot).toBe("/slack");
    expect(definition.displayName).toBe("Slack");
    expect(definition.aliases).toEqual(["slack-sage", "slack-sage-preview"]);
  });

  it("does not collide the slack rename with sibling slack-* product apps", () => {
    expect(resolveWorkspaceIntegrationProvider("slack-my-senior-dev")).toBe(
      "slack-my-senior-dev",
    );
    expect(resolveWorkspaceIntegrationProvider("slack-nightcto")).toBe(
      "slack-nightcto",
    );
    expect(resolveWorkspaceIntegrationProvider("slack-ricky")).toBe(
      "slack-ricky",
    );
  });

  it("registers Jira with its relay config key and /jira VFS root", () => {
    expect(isWorkspaceIntegrationProvider("jira")).toBe(true);
    expect(resolveWorkspaceIntegrationProvider("jira-sage")).toBe("jira");
    expect(getProviderConfigKey("jira")).toBe("jira-relay");

    const definition = getWorkspaceIntegrationProviderDefinition("jira");
    expect(definition.displayName).toBe("Jira");
    expect(definition.vfsRoot).toBe("/jira");
    expect(definition.aliases).toEqual(["jira-sage"]);
  });

  it("registers Confluence with its relay config key and /confluence VFS root", () => {
    expect(isWorkspaceIntegrationProvider("confluence")).toBe(true);
    expect(resolveWorkspaceIntegrationProvider("confluence")).toBe("confluence");
    expect(getProviderConfigKey("confluence")).toBe("confluence-relay");

    const definition = getWorkspaceIntegrationProviderDefinition("confluence");
    expect(definition.displayName).toBe("Confluence");
    expect(definition.vfsRoot).toBe("/confluence");
    expect(definition.aliases).toEqual([]);
  });

  it("registers Telegram with its relay config key and /telegram VFS root", () => {
    expect(isWorkspaceIntegrationProvider("telegram")).toBe(true);
    expect(resolveWorkspaceIntegrationProvider("telegram-relay")).toBe("telegram");
    expect(getProviderConfigKey("telegram")).toBe("telegram-relay");

    const definition = getWorkspaceIntegrationProviderDefinition("telegram");
    expect(definition.displayName).toBe("Telegram");
    expect(definition.vfsRoot).toBe("/telegram");
    expect(definition.aliases).toEqual(["telegram-relay"]);
  });
});
