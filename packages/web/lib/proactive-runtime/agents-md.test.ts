import { describe, expect, it } from "vitest";
import { renderAgentsMd } from "./agents-md";

describe("renderAgentsMd", () => {
  it("renders stable deploy context without secrets", () => {
    const content = renderAgentsMd({
      agent: { id: "agent-1", deployedName: "weekly-digest" },
      persona: {
        id: "weekly-digest",
        version: 2,
        harness: "claude",
        model: "claude-sonnet-4",
        systemPrompt: "Summarize updates. SECRET_TOKEN=hidden",
      },
      integrations: {
        notion: { source: { kind: "deployer_user" } },
        github: { source: { kind: "workspace_service_account", name: "release-bot" } },
      },
      relaycast: {
        workspace: "rw_test",
        agentName: "agent-1",
        defaultWorkspaceId: "workspace-1",
      },
      schedules: [{ name: "daily", cron: "0 9 * * *", tz: "UTC" }],
    });

    expect(content).toContain("# Agent: weekly-digest");
    expect(content).toContain("Persona: weekly-digest v2");
    expect(content.indexOf("- github: release-bot")).toBeLessThan(
      content.indexOf("- notion: default"),
    );
    expect(content).toContain("- daily: 0 9 * * * UTC");
    expect(content).toContain("- agent name: agent-1");
    expect(content).toContain("SECRET_TOKEN=[redacted]");
    expect(content).not.toContain("hidden");
    expect(content).not.toContain("x-api-key");
  });
});
