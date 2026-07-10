import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectedIntegrationStatesFromList,
  fetchWorkspaceIntegrations,
} from "./workspace-integrations-client";
import type { PersonaIntegrationSummary } from "./types";

const personaIntegrations: PersonaIntegrationSummary[] = [
  {
    provider: "slack",
    label: "Slack",
    providerConfigKey: "slack",
    description: "Post updates.",
  },
  {
    provider: "github",
    label: "GitHub",
    providerConfigKey: "github",
    description: "Read repositories.",
  },
];

describe("fetchWorkspaceIntegrations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the workspace integration list through the app base path", async () => {
    const fetchMock = vi.fn(async () => Response.json([
      {
        provider: "slack",
        providerConfigKey: "slack-sage",
        status: "ready",
        connectionId: "conn_slack",
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkspaceIntegrations("rw_12345678")).resolves.toEqual([
      {
        provider: "slack",
        providerConfigKey: "slack-sage",
        status: "ready",
        connectionId: "conn_slack",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/cloud/api/v1/workspaces/rw_12345678/integrations",
      { cache: "no-store", credentials: "include" },
    );
  });

  it("matches connected providers by provider key, not provider config key", () => {
    expect(connectedIntegrationStatesFromList(personaIntegrations, [
      {
        provider: "slack",
        providerConfigKey: "slack-nightcto",
        status: "ready",
        connectionId: "conn_slack",
      },
      {
        provider: "github",
        providerConfigKey: "github",
        status: "error",
        connectionId: "conn_github",
      },
    ])).toEqual({
      slack: {
        provider: "slack",
        state: "connected",
        connectionId: "conn_slack",
      },
    });
  });
});
