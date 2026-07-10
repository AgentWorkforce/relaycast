import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBoundRelayWorkspaceId: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRelayfileInternalHmacSecret: vi.fn(),
  isGithubInstallationCentricEnabled: vi.fn(),
  resolveGithubConnectionForWorkspace: vi.fn(),
  signRelayfileInternalRequest: vi.fn(),
}));

vi.mock("../workspaces/relay-workspace-binding", async () => {
  const actual = await vi.importActual<
    typeof import("../workspaces/relay-workspace-binding")
  >("../workspaces/relay-workspace-binding");
  return {
    ...actual,
    readBoundRelayWorkspaceId: mocks.readBoundRelayWorkspaceId,
  };
});

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("./relayfile-writeback-auth", () => ({
  resolveRelayfileInternalHmacSecret: mocks.resolveRelayfileInternalHmacSecret,
  signRelayfileInternalRequest: mocks.signRelayfileInternalRequest,
}));

vi.mock("./github-installation-centric-flag", () => ({
  isGithubInstallationCentricEnabled: mocks.isGithubInstallationCentricEnabled,
}));

vi.mock("./github-installation-connection", () => ({
  resolveGithubConnectionForWorkspace:
    mocks.resolveGithubConnectionForWorkspace,
}));

import {
  isRelayfileCloudNangoIngestCredentialTarget,
  pushRelayfileIntegrationCredential,
  RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV,
  resolveRelayfileCredentialWorkspaceId,
  shouldPushRelayfileCloudNangoIngestCredential,
} from "./relayfile-integration-push";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

function integration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  const now = new Date("2026-06-04T10:00:00.000Z");
  return {
    id: "integration_123",
    workspaceId: "6090d557-246a-4b1f-a368-5d8a9e4f2092",
    provider: "github",
    connectionId: "conn_123",
    providerConfigKey: "github-relay",
    installationId: null,
    metadata: { readiness: { status: "pending" } },
    writebackDispatchVia: "bridge",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("resolveRelayfileCredentialWorkspaceId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the bound Relayfile workspace for app workspace UUIDs", async () => {
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_7ca2b192");

    await expect(
      resolveRelayfileCredentialWorkspaceId(
        "6090d557-246a-4b1f-a368-5d8a9e4f2092",
      ),
    ).resolves.toBe("rw_7ca2b192");
  });

  it("keeps existing Relayfile workspace ids without a database lookup", async () => {
    await expect(
      resolveRelayfileCredentialWorkspaceId("rw_7ca2b192"),
    ).resolves.toBe("rw_7ca2b192");
    expect(mocks.readBoundRelayWorkspaceId).not.toHaveBeenCalled();
  });
});

describe("pushRelayfileIntegrationCredential", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.readBoundRelayWorkspaceId.mockResolvedValue("rw_7ca2b192");
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.test/",
    });
    mocks.resolveRelayfileInternalHmacSecret.mockReturnValue("secret");
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(false);
    mocks.resolveGithubConnectionForWorkspace.mockResolvedValue({
      installationId: "inst-123",
      connectionId: "conn-installation",
      providerConfigKey: "github-relay",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      source: "org-installation",
    });
    mocks.signRelayfileInternalRequest.mockReturnValue("signature");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushes credentials to the bound Relayfile workspace when rows use app UUIDs", async () => {
    const result = await pushRelayfileIntegrationCredential(integration());

    expect(result).toEqual({ ok: true, provider: "github", status: 204 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relayfile.test/v1/workspaces/rw_7ca2b192/integrations/github",
      expect.objectContaining({
        method: "PUT",
      }),
    );
    expect(mocks.resolveGithubConnectionForWorkspace).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({
      provider: "github",
      providerConfigKey: "github-relay",
      connectionId: "conn_123",
      aliasFields: { readiness: { status: "pending" } },
      revoked: false,
      updatedAt: "2026-06-04T10:00:00.000Z",
      writebackDispatchVia: "bridge",
    });
  });

  it("keeps the PUT shape but sources active GitHub credentials from the installation resolver when the flag is on", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);

    const result = await pushRelayfileIntegrationCredential(integration());

    expect(result).toEqual({ ok: true, provider: "github", status: 204 });
    expect(mocks.resolveGithubConnectionForWorkspace).toHaveBeenCalledWith(
      "6090d557-246a-4b1f-a368-5d8a9e4f2092",
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(Object.keys(body)).toEqual([
      "provider",
      "providerConfigKey",
      "connectionId",
      "aliasFields",
      "revoked",
      "updatedAt",
      "writebackDispatchVia",
    ]);
    expect(body).toMatchObject({
      provider: "github",
      providerConfigKey: "github-relay",
      connectionId: "conn-installation",
      revoked: false,
    });
  });

  it("does not resolve the shared installation connection for workspace-scoped revokes", async () => {
    mocks.isGithubInstallationCentricEnabled.mockReturnValue(true);

    const result = await pushRelayfileIntegrationCredential(integration(), {
      revoked: true,
    });

    expect(result).toEqual({ ok: true, provider: "github", status: 204 });
    expect(mocks.resolveGithubConnectionForWorkspace).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      provider: "github",
      providerConfigKey: "github-relay",
      connectionId: "conn_123",
      revoked: true,
    });
  });

  it("forces relayfile-cloud-owned Nango ingest credentials to CF dispatch when the migration flag is enabled", async () => {
    const result = await pushRelayfileIntegrationCredential(
      integration({
        provider: "linear",
        providerConfigKey: "linear-relay",
        writebackDispatchVia: "bridge",
      }),
      {
        env: { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "true" },
      },
    );

    expect(result).toEqual({ ok: true, provider: "linear", status: 204 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      provider: "linear",
      providerConfigKey: "linear-relay",
      writebackDispatchVia: "cf",
    });
  });

  it("pushes HubSpot credentials to relayfile-cloud for Nango webhook routing", async () => {
    const result = await pushRelayfileIntegrationCredential(
      integration({
        provider: "hubspot",
        providerConfigKey: "hubspot-relay",
        connectionId: "564b7416-0d6e-4bc4-94c6-4bfc2e7f9dc8",
      }),
      {
        env: { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "true" },
      },
    );

    expect(result).toEqual({ ok: true, provider: "hubspot", status: 204 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://relayfile.test/v1/workspaces/rw_7ca2b192/integrations/hubspot",
      expect.objectContaining({
        method: "PUT",
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      provider: "hubspot",
      providerConfigKey: "hubspot-relay",
      connectionId: "564b7416-0d6e-4bc4-94c6-4bfc2e7f9dc8",
      writebackDispatchVia: "cf",
    });
  });

  it("filters product Slack config keys before slack normalization when the migration flag is enabled", async () => {
    const result = await pushRelayfileIntegrationCredential(
      integration({
        provider: "slack-nightcto",
        providerConfigKey: "slack-nightcto",
        writebackDispatchVia: "bridge",
      }),
      {
        env: { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "true" },
      },
    );

    expect(result).toEqual({ ok: true, provider: "slack", status: 204 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      provider: "slack",
      providerConfigKey: "slack-nightcto",
      writebackDispatchVia: "bridge",
    });
  });
});

describe("relayfile-cloud Nango ingest credential targeting", () => {
  it("targets first-tier provider config keys when the migration flag is enabled", () => {
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "slack", providerConfigKey: "slack-relay" },
        { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "enabled" },
      ),
    ).toBe(true);
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "google-mail", providerConfigKey: "google-mail-relay" },
        { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "1" },
      ),
    ).toBe(true);
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "hubspot", providerConfigKey: "hubspot-relay" },
        { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "true" },
      ),
    ).toBe(true);
  });

  it("does not target excluded product app config keys", () => {
    const enabledEnv = { [RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV]: "true" };

    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "slack-nightcto", providerConfigKey: "slack-nightcto" },
        enabledEnv,
      ),
    ).toBe(false);
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        {
          provider: "slack-my-senior-dev",
          providerConfigKey: "slack-my-senior-dev",
        },
        enabledEnv,
      ),
    ).toBe(false);
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "linear-ricky", providerConfigKey: "linear-ricky" },
        enabledEnv,
      ),
    ).toBe(false);
  });

  it("falls back to exact canonical provider names only when the config key is absent", () => {
    expect(
      isRelayfileCloudNangoIngestCredentialTarget({
        provider: "slack",
        providerConfigKey: null,
      }),
    ).toBe(true);
    expect(
      isRelayfileCloudNangoIngestCredentialTarget({
        provider: "slack-nightcto",
        providerConfigKey: null,
      }),
    ).toBe(false);
    expect(
      isRelayfileCloudNangoIngestCredentialTarget({
        provider: "slack",
        providerConfigKey: "slack-nightcto",
      }),
    ).toBe(false);
  });

  it("treats malformed optional inputs as disabled instead of throwing", () => {
    expect(
      shouldPushRelayfileCloudNangoIngestCredential(
        { provider: "slack", providerConfigKey: "slack-relay" },
        null,
      ),
    ).toBe(false);
    expect(isRelayfileCloudNangoIngestCredentialTarget(null)).toBe(false);
    expect(
      isRelayfileCloudNangoIngestCredentialTarget({
        provider: "",
        providerConfigKey: null,
      }),
    ).toBe(false);
  });
});
