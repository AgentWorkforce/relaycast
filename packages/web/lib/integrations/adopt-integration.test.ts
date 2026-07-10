import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNangoConnectionDetails: vi.fn(),
  probeNangoConnectionLiveness: vi.fn(),
  getProviderConfigKey: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  replaceWorkspaceIntegrationConnectionIfStale: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  readWorkspaceIdFromAuthPayload: vi.fn(),
  markProviderOAuthConnected: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoConnectionDetails: mocks.getNangoConnectionDetails,
  probeNangoConnectionLiveness: mocks.probeNangoConnectionLiveness,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/integrations/nango-webhook-router", () => ({
  readWorkspaceIdFromAuthPayload: mocks.readWorkspaceIdFromAuthPayload,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
  insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
  replaceWorkspaceIntegrationConnectionIfStale:
    mocks.replaceWorkspaceIntegrationConnectionIfStale,
  findWorkspaceIntegrationByConnection:
    mocks.findWorkspaceIntegrationByConnection,
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderOAuthConnected: mocks.markProviderOAuthConnected,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { adoptIntegrationConnection } from "./adopt-integration";

describe("adoptIntegrationConnection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getProviderConfigKey.mockReturnValue("github-relay");
    mocks.readWorkspaceIdFromAuthPayload.mockReturnValue("rw_12345678");
  });

  it("returns connection_not_found when Nango has no record of the connectionId", async () => {
    // Operators sometimes typo the connectionId or copy a stale one from a
    // deleted Nango environment. The adopt route must not leave a row
    // pointing at a connectionId Nango can't honor — that would silently
    // strand all sync webhooks for the workspace. Verify we refuse before
    // touching the DB.
    mocks.getNangoConnectionDetails.mockResolvedValue(null);

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_missing",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "connection_not_found",
    });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.markProviderOAuthConnected).not.toHaveBeenCalled();
  });

  it("refuses adoption when the connection is tagged for a different workspace", async () => {
    // Cross-workspace moves are out of scope for adopt. The 409 carries
    // both ids so the operator can either fix the Nango end-user tag or
    // re-run against the correct workspace path.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_other" } },
      installationId: null,
    });
    mocks.readWorkspaceIdFromAuthPayload.mockReturnValue("rw_other");

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_for_other_ws",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "workspace_mismatch",
      pathWorkspaceId: "rw_12345678",
      connectionWorkspaceId: "rw_other",
    });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
  });

  it("inserts a fresh row when no integration exists for the slot", async () => {
    // Happy path A: operator minted a connection directly in Nango UI,
    // cloud has never seen the workspace/provider pair. Insert succeeds,
    // readiness is seeded, and the result signals no replacement happened.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: "inst_999",
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: true,
    });

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_fresh",
    });

    expect(result).toEqual({ ok: true, connectionId: "conn_fresh" });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_fresh",
        providerConfigKey: "github-relay",
        installationId: "inst_999",
      }),
    );
    expect(mocks.markProviderOAuthConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_fresh",
        providerConfigKey: "github-relay",
      }),
    );
    expect(mocks.probeNangoConnectionLiveness).not.toHaveBeenCalled();
    expect(mocks.replaceWorkspaceIntegrationConnectionIfStale).not.toHaveBeenCalled();
  });

  it("treats adoption of the same connectionId as idempotent success", async () => {
    // Operators run adopt as a recovery / repair command; running it twice
    // in a row must not error. When the row already points at the supplied
    // connectionId we refresh the readiness blob and return ok with no
    // replacedConnectionId.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_already_here",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_already_here",
    });

    expect(result).toEqual({
      ok: true,
      connectionId: "conn_already_here",
    });
    expect(mocks.probeNangoConnectionLiveness).not.toHaveBeenCalled();
    expect(mocks.replaceWorkspaceIntegrationConnectionIfStale).not.toHaveBeenCalled();
    expect(mocks.markProviderOAuthConnected).toHaveBeenCalled();
  });

  it("replaces a stale row when the existing connection is gone upstream", async () => {
    // Happy path B: the workspace had an old connection that the operator
    // deleted directly in Nango (or that Nango reaped). The row is stale
    // and no webhook will ever reach it. probe -> "gone", CAS replace
    // succeeds, result carries replacedConnectionId so the CLI can tell the
    // operator a migration happened.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_dead_old",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mocks.probeNangoConnectionLiveness.mockResolvedValue("gone");
    mocks.replaceWorkspaceIntegrationConnectionIfStale.mockResolvedValue({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_new_replacement",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_new_replacement",
    });

    expect(result).toEqual({
      ok: true,
      connectionId: "conn_new_replacement",
      replacedConnectionId: "conn_dead_old",
    });
    expect(mocks.probeNangoConnectionLiveness).toHaveBeenCalledWith(
      "conn_dead_old",
      "github-relay",
    );
    expect(mocks.replaceWorkspaceIntegrationConnectionIfStale).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_new_replacement",
        expectedConnectionId: "conn_dead_old",
      }),
    );
    expect(mocks.markProviderOAuthConnected).toHaveBeenCalled();
  });

  it("refuses replacement when the existing connection is still live upstream", async () => {
    // Safety property: don't trample a live tenant. The operator must
    // disconnect the existing connection explicitly first; that's the
    // contract the disconnect CLI already provides.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_still_live",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mocks.probeNangoConnectionLiveness.mockResolvedValue("alive");

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_intruder",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "existing_connection_live_or_unknown",
      existingConnectionId: "conn_still_live",
      existingLiveness: "alive",
    });
    expect(mocks.replaceWorkspaceIntegrationConnectionIfStale).not.toHaveBeenCalled();
    expect(mocks.markProviderOAuthConnected).not.toHaveBeenCalled();
  });

  it("refuses replacement when liveness is indeterminate", async () => {
    // 401/5xx from Nango is a "don't know" — replacing on unknown could
    // stomp a live tenant when Nango is briefly unreachable or the secret
    // key has rotated. Conservative refusal mirrors selfHealMissing
    // WorkspaceIntegration.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_maybe_live",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mocks.probeNangoConnectionLiveness.mockResolvedValue("unknown");

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_intruder",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "existing_connection_live_or_unknown",
      existingConnectionId: "conn_maybe_live",
      existingLiveness: "unknown",
    });
    expect(mocks.replaceWorkspaceIntegrationConnectionIfStale).not.toHaveBeenCalled();
  });

  it("returns ok: false with unknown liveness when the CAS replace loses to a concurrent writer", async () => {
    // Race: two adopts (or one adopt and one self-heal) probe in parallel,
    // both see "gone", both call replace. Only one CAS succeeds. The loser
    // must NOT retry blindly — the row's new state has not been verified
    // against this caller's intent. Surface the race so the operator can
    // re-run if they still want to adopt.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_12345678",
        provider: "github",
        connectionId: "conn_dead",
        providerConfigKey: "github-relay",
        installationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mocks.probeNangoConnectionLiveness.mockResolvedValue("gone");
    mocks.replaceWorkspaceIntegrationConnectionIfStale.mockResolvedValue(null);

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_replacement",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "existing_connection_live_or_unknown",
      existingLiveness: "unknown",
    });
    expect(mocks.markProviderOAuthConnected).not.toHaveBeenCalled();
  });

  it("reports which slot already binds the connectionId when the insert conflicts on providerConnectionUnique", async () => {
    // The untargeted ON CONFLICT DO NOTHING also guards
    // providerConnectionUnique (provider, connection_id). When THAT index
    // fires, no row exists at (workspaceId, provider, name) — so getWorkspace
    // Integration returns null — yet a different slot already binds this exact
    // connectionId. Surface where it lives instead of a misleading "retry".
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: undefined,
    });
    mocks.getWorkspaceIntegration.mockResolvedValue(null);
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_otherws",
      provider: "github",
      name: "secondary",
      connectionId: "conn_shared",
      providerConfigKey: "github-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_shared",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "existing_connection_live_or_unknown",
      existingConnectionId: "conn_shared",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("rw_otherws");
      expect(result.message).toContain("secondary");
    }
    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "github",
      "conn_shared",
    );
    expect(mocks.probeNangoConnectionLiveness).not.toHaveBeenCalled();
    expect(mocks.markProviderOAuthConnected).not.toHaveBeenCalled();
  });

  it("falls back to the race message when the conflicting row truly vanished", async () => {
    // Insert reported a conflict, but neither the (workspaceId, provider, name)
    // slot nor any slot binding this connectionId exists by the time we
    // re-read — a genuine race with deleteWorkspaceIntegration. Keep the
    // retry-able "race" response.
    mocks.getNangoConnectionDetails.mockResolvedValue({
      payload: { end_user: { id: "rw_12345678" } },
      installationId: null,
    });
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({
      inserted: false,
      existing: undefined,
    });
    mocks.getWorkspaceIntegration.mockResolvedValue(null);
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);

    const result = await adoptIntegrationConnection({
      workspaceId: "rw_12345678",
      provider: "github",
      connectionId: "conn_vanished",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "existing_connection_live_or_unknown",
      existingLiveness: "unknown",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Retry");
    }
    expect(mocks.markProviderOAuthConnected).not.toHaveBeenCalled();
  });
});
