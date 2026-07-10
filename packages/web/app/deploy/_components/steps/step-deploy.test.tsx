import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { subscriptionCredentialMissingMessage } from "../../_lib/deploy-client";
import type { PersonaSummary } from "../../_lib/types";
import { StepDeploy } from "./step-deploy";

function persona(overrides: Partial<PersonaSummary> = {}): PersonaSummary {
  return {
    id: "repo-hygiene",
    name: "Repo Hygiene",
    description: "Keep repositories tidy.",
    slug: "repo-hygiene",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: true,
    integrations: [],
    inputs: [],
    triggers: [],
    ...overrides,
  };
}

describe("StepDeploy", () => {
  it("shows the subscription credential block message on the deploy screen", () => {
    const html = renderToStaticMarkup(
      <StepDeploy
        persona={persona()}
        workspace={{ id: "workspace-1", name: "Workspace", slug: "workspace", organization_id: "org-1" }}
        integrationStates={{}}
        harnessSource="oauth"
        inputValues={{}}
        deployPhase="idle"
        progressMessages={[]}
        deployError={null}
        subscriptionCredentialMessage="No active subscription credentials are connected. Run `npx agent-relay cloud connect openai`, mark the credential Active, then deploy again."
      />,
    );

    expect(html).toContain("No active subscription credentials are connected");
    expect(html).toContain("npx agent-relay cloud connect openai");
  });

  it("points a missing Anthropic setup-token back to the inline panel", () => {
    const message = subscriptionCredentialMissingMessage("anthropic");
    const html = renderToStaticMarkup(
      <StepDeploy
        persona={persona({ harness: "claude", modelProvider: "anthropic", model: "claude-sonnet-4-6" })}
        workspace={{ id: "workspace-1", name: "Workspace", slug: "workspace", organization_id: "org-1" }}
        integrationStates={{}}
        harnessSource="oauth"
        inputValues={{}}
        deployPhase="idle"
        progressMessages={[]}
        deployError={null}
        subscriptionCredentialMessage={message}
      />,
    );

    expect(html).toContain("Claude subscription setup-token panel");
    expect(html).toContain("claude setup-token");
    expect(html).not.toContain("agent-relay cloud connect anthropic");
  });
});
