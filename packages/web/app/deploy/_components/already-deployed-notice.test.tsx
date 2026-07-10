import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeployedAgentMatch } from "../_lib/deployed-status-client";
import { AlreadyDeployedNotice } from "./already-deployed-notice";

function match(overrides: Partial<DeployedAgentMatch> = {}): DeployedAgentMatch {
  return {
    agentId: "agent-1",
    deployedName: "hn-monitor",
    status: "ready",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastFiredAt: null,
    ...overrides,
  };
}

describe("AlreadyDeployedNotice", () => {
  it("renders nothing while unknown (null) and when there are no matches", () => {
    expect(renderToStaticMarkup(<AlreadyDeployedNotice matches={null} workspaceName="Acme" />)).toBe("");
    expect(renderToStaticMarkup(<AlreadyDeployedNotice matches={[]} workspaceName="Acme" />)).toBe("");
  });

  it("renders a single match with name, relative time, and the agent dashboard link", () => {
    const html = renderToStaticMarkup(
      <AlreadyDeployedNotice matches={[match()]} workspaceName="Acme" />,
    );

    expect(html).toContain("Already deployed in Acme");
    expect(html).toContain("hn-monitor");
    expect(html).toContain("2h ago");
    // Raw dashboard path inside <Link> — basePath is added by Next, never
    // pre-prefixed with toAppPath.
    expect(html).toContain('href="/dashboard/workforce/agents/agent-1"');
    // Calm info notice, not a blocker: the flow continues below.
    expect(html).toContain("still deploy another copy");
  });

  it("renders a count and the agents-list link for multiple matches", () => {
    const html = renderToStaticMarkup(
      <AlreadyDeployedNotice
        matches={[match(), match({ agentId: "agent-2" })]}
        workspaceName="Acme"
      />,
    );

    expect(html).toContain("2 agents");
    expect(html).toContain('href="/dashboard/workforce/agents"');
    expect(html).not.toContain('href="/dashboard/workforce/agents/agent-1"');
  });

  it("falls back to a generic workspace label when the name is unknown", () => {
    const html = renderToStaticMarkup(
      <AlreadyDeployedNotice matches={[match()]} workspaceName={null} />,
    );
    expect(html).toContain("Already deployed in this workspace");
  });
});
