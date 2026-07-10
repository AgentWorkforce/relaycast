import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { connectedIntegrationStatesFromList } from "../../_lib/workspace-integrations-client";
import type { IntegrationState, PersonaIntegrationSummary } from "../../_lib/types";
import { StepIntegrations } from "./step-integrations";

vi.mock("../../_lib/use-nango-connect", () => ({
  useNangoConnect: () => ({
    requestSession: vi.fn(),
    openConnectUi: vi.fn(),
    saveIntegration: vi.fn(),
    listIntegrations: vi.fn(),
  }),
}));

const integrations: PersonaIntegrationSummary[] = [
  {
    provider: "slack",
    label: "Slack",
    providerConfigKey: "slack",
    description: "Post updates.",
  },
];

function renderStep(states: Record<string, IntegrationState>) {
  return renderToStaticMarkup(
    <StepIntegrations
      mode="live"
      workspaceId="rw_12345678"
      integrations={integrations}
      states={states}
      onChange={vi.fn()}
    />,
  );
}

describe("StepIntegrations", () => {
  it("shows a row loading state before live connected integrations are checked", () => {
    const html = renderStep({
      slack: { provider: "slack", state: "idle" },
    });

    expect(html).toContain("Checking");
    expect(html).not.toContain(">Connect</button>");
  });

  it("renders a same-provider pre-connected integration as connected without user action", () => {
    const states = connectedIntegrationStatesFromList(integrations, [
      {
        provider: "slack",
        providerConfigKey: "slack-sage",
        status: "ready",
        connectionId: "conn_slack",
      },
    ]);

    const html = renderStep(states);

    expect(html).toContain("Connected");
    expect(html).toContain("Reconnect");
  });
});

const daytonaIntegrations: PersonaIntegrationSummary[] = [
  {
    provider: "daytona",
    label: "Daytona",
    providerConfigKey: "daytona",
    description: "Watch sandbox usage.",
  },
];

function renderDaytonaStep(states: Record<string, IntegrationState>) {
  return renderToStaticMarkup(
    <StepIntegrations
      mode="live"
      workspaceId="rw_12345678"
      integrations={daytonaIntegrations}
      states={states}
      onChange={vi.fn()}
    />,
  );
}

describe("StepIntegrations daytona (CLI-captured)", () => {
  it("instructs the relay CLI capture command + polls instead of a Nango connect", () => {
    const html = renderDaytonaStep({
      daytona: { provider: "daytona", state: "idle" },
    });

    expect(html).toContain("agent-relay cloud connect daytona");
    expect(html).toContain("Copy");
    expect(html).toContain("Waiting for the Daytona credential");
    expect(html).toContain("Check connection");
    // No browser-OAuth "Connect" button for a CLI-captured provider.
    expect(html).not.toContain(">Connect</button>");
    expect(html).not.toContain("opens browser");
  });

  it("renders a connected daytona integration without the instruct command", () => {
    const html = renderDaytonaStep({
      daytona: { provider: "daytona", state: "connected", connectionId: "daytona" },
    });

    expect(html).toContain("Connected");
    expect(html).not.toContain("agent-relay cloud connect daytona");
    expect(html).not.toContain("Waiting for the Daytona credential");
  });
});
