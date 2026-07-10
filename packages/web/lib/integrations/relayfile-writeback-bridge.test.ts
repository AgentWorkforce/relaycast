import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

const {
  getNangoClientMock,
  getProviderConfigKeyMock,
  getWorkspaceIntegrationByProviderAliasMock,
  resolveWorkspaceIntegrationIdentityMock,
  proxyMock,
  findReceiptMock,
  recordReceiptMock,
  markReceiptAckedMock,
} = vi.hoisted(() => ({
  getNangoClientMock: vi.fn(),
  getProviderConfigKeyMock: vi.fn(),
  getWorkspaceIntegrationByProviderAliasMock: vi.fn(),
  resolveWorkspaceIntegrationIdentityMock: vi.fn(),
  proxyMock: vi.fn(),
  findReceiptMock: vi.fn(),
  recordReceiptMock: vi.fn(),
  markReceiptAckedMock: vi.fn(),
}));

vi.mock("./nango-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nango-service")>()),
  getNangoClient: getNangoClientMock,
  getProviderConfigKey: getProviderConfigKeyMock,
}));

vi.mock("./workspace-integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-integrations")>()),
  getWorkspaceIntegrationByProviderAlias: getWorkspaceIntegrationByProviderAliasMock,
}));

vi.mock("../workspaces/workspace-integration-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspaces/workspace-integration-identity")>()),
  resolveWorkspaceIntegrationIdentity: resolveWorkspaceIntegrationIdentityMock,
}));

vi.mock("./relayfile-writeback-receipts", () => ({
  findRelayfileWritebackReceipt: findReceiptMock,
  recordRelayfileWritebackReceipt: recordReceiptMock,
  markRelayfileWritebackReceiptAcked: markReceiptAckedMock,
}));

vi.mock("../relayfile", () => ({
  resolveRelayfileConfig: () => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "relayauth-key",
  }),
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: class {
    getBaseUrl(): string {
      return "https://relayfile.test";
    }
    async getToken(): Promise<string> {
      return "test-token";
    }
  },
}));

function buildIntegration(
  overrides: Partial<WorkspaceIntegrationRecord> & {
    backendIntegrationId?: string | null;
  } = {},
): WorkspaceIntegrationRecord & { backendIntegrationId?: string | null } {
  return {
    id: "integration_writeback",
    workspaceId: "ws_writeback",
    provider: "notion",
    connectionId: "conn_writeback",
    providerConfigKey: "notion-legacy",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-08T00:00:00.000Z"),
    updatedAt: new Date("2026-05-08T00:00:00.000Z"),
    ...overrides,
  };
}

function mockSingleWorkspaceIdentity(workspaceId: string) {
  return {
    requestedWorkspaceId: workspaceId,
    appWorkspaceId: null,
    relayWorkspaceId: workspaceId,
    organizationId: null,
    candidateWorkspaceIds: [workspaceId],
  };
}

async function loadBridge() {
  return import("./relayfile-writeback-bridge");
}

describe("relayfile writeback bridge backend integration ids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getProviderConfigKeyMock.mockImplementation(
      (provider: string) => `${provider}-default`,
    );
    getNangoClientMock.mockReturnValue({ proxy: proxyMock });
    proxyMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { id: "page-1" },
    });
    resolveWorkspaceIntegrationIdentityMock.mockImplementation(
      async (workspaceId: string) => mockSingleWorkspaceIdentity(workspaceId),
    );
  });

  afterEach(() => {
    vi.doUnmock("@relayfile/adapter-jira/writeback");
  });

  it("prefers backendIntegrationId when future-shaped records provide it", async () => {
    const { resolveBackendIntegrationId } = await loadBridge();

    expect(
      resolveBackendIntegrationId(
        buildIntegration({
          backendIntegrationId: "notion-backend",
          providerConfigKey: "notion-legacy",
        }),
      ),
    ).toBe("notion-backend");
  });

  it("falls back to providerConfigKey for legacy records", async () => {
    const { resolveBackendIntegrationId } = await loadBridge();

    expect(
      resolveBackendIntegrationId(
        buildIntegration({
          backendIntegrationId: null,
          providerConfigKey: "notion-legacy",
        }),
      ),
    ).toBe("notion-legacy");
  });

  it("falls back to the static provider config key when no row id is present", async () => {
    const { resolveBackendIntegrationId } = await loadBridge();

    expect(
      resolveBackendIntegrationId(
        buildIntegration({
          backendIntegrationId: undefined,
          providerConfigKey: null,
        }),
      ),
    ).toBe("notion-default");
    expect(getProviderConfigKeyMock).toHaveBeenCalledWith("notion");
  });

  it("uses the resolved backend id for Notion proxy requests", async () => {
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        backendIntegrationId: "notion-backend",
        providerConfigKey: "notion-legacy",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_notion",
      workspaceId: "ws_writeback",
      path: "/notion/databases/db-1/pages/new-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "notion",
      content: JSON.stringify({
        properties: {
          Name: { title: [{ text: { content: "Updated" } }] },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result.outcome).toBe("success");
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_writeback",
        providerConfigKey: "notion-backend",
      }),
    );
  });

  it("resolves Slack writebacks through the bound relay workspace id when the op carries an app UUID", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: appWorkspaceId,
      appWorkspaceId,
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [appWorkspaceId, relayWorkspaceId],
    });
    getWorkspaceIntegrationByProviderAliasMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildIntegration({
          workspaceId: relayWorkspaceId,
          provider: "slack",
          connectionId: "conn_slack",
          providerConfigKey: "slack-relay",
        }),
      );
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { ok: true, ts: "1713220123.001100" },
    });
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_slack_app_uuid",
      workspaceId: appWorkspaceId,
      path: "/slack/channels/C0TESTCHAN/messages/draft@top-level.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "slack",
      content: JSON.stringify({ text: "Top-level message" }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "slack",
      metadata: {
        action: "post_message",
        endpoint: "/chat.postMessage",
        externalId: "1713220123.001100",
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenNthCalledWith(
      1,
      relayWorkspaceId,
      "slack",
    );
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
        endpoint: "/chat.postMessage",
        data: { text: "Top-level message", channel: "C0TESTCHAN" },
      }),
    );
  });

  it("injects parentExternalId as thread_ts for a Slack chat.postMessage writeback (server-side threading)", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: appWorkspaceId,
      appWorkspaceId,
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [appWorkspaceId, relayWorkspaceId],
    });
    getWorkspaceIntegrationByProviderAliasMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildIntegration({
          workspaceId: relayWorkspaceId,
          provider: "slack",
          connectionId: "conn_slack",
          providerConfigKey: "slack-relay",
        }),
      );
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { ok: true, ts: "1713220123.002200" },
    });
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_slack_threaded",
      workspaceId: appWorkspaceId,
      path: "/slack/channels/C0TESTCHAN/messages/reply card.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "slack",
      content: JSON.stringify({
        text: "Threaded card",
        blocks: [{ type: "section" }],
      }),
      contentType: "application/json",
      encoding: "utf-8",
      parentExternalId: "1713220100.000100",
    });

    expect(result.outcome).toBe("success");
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/chat.postMessage",
        data: expect.objectContaining({
          channel: "C0TESTCHAN",
          thread_ts: "1713220100.000100",
        }),
      }),
    );
  });

  it("resolves writebacks when the op already carries the relay workspace id", async () => {
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: relayWorkspaceId,
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [
        relayWorkspaceId,
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      ],
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValueOnce(
      buildIntegration({
        workspaceId: relayWorkspaceId,
        provider: "notion",
        connectionId: "conn_notion",
        providerConfigKey: "notion-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_notion_relay_id",
      workspaceId: relayWorkspaceId,
      path: "/notion/databases/db-1/pages/new-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "notion",
      content: JSON.stringify({
        properties: {
          Name: { title: [{ text: { content: "Updated" } }] },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result.outcome).toBe("success");
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenCalledWith(
      relayWorkspaceId,
      "notion",
    );
  });

  it("returns integration_not_found only after trying all workspace identity candidates", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: appWorkspaceId,
      appWorkspaceId,
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [appWorkspaceId, relayWorkspaceId],
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(null);
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_missing_candidates",
      workspaceId: appWorkspaceId,
      path: "/notion/databases/db-1/pages/new-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "notion",
      content: JSON.stringify({
        properties: {
          Name: { title: [{ text: { content: "Updated" } }] },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "notion",
      error: {
        code: "integration_not_found",
        message: expect.stringContaining(
          `candidates tried: ${relayWorkspaceId}, ${appWorkspaceId}`,
        ),
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenNthCalledWith(
      1,
      relayWorkspaceId,
      "notion",
    );
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenNthCalledWith(
      2,
      appWorkspaceId,
      "notion",
    );
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("routes Linear create issue after resolving an app UUID to its relay workspace integration", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: appWorkspaceId,
      appWorkspaceId,
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [appWorkspaceId, relayWorkspaceId],
    });
    getWorkspaceIntegrationByProviderAliasMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildIntegration({
          workspaceId: relayWorkspaceId,
          provider: "linear",
          connectionId: "conn_linear",
          providerConfigKey: "linear-relay",
        }),
      );
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-uuid-1",
              identifier: "LIN-99",
              url: "https://linear.app/x/issue/LIN-99",
            },
          },
        },
      },
    });
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_linear_app_uuid",
      workspaceId: appWorkspaceId,
      path: "/linear/issues/create request.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "linear",
      content: JSON.stringify({
        teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
        title: "Bridge integration smoke test",
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "linear",
      metadata: {
        action: "create_issue",
        method: "POST",
        endpoint: "/graphql",
        externalId: "issue-uuid-1",
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenNthCalledWith(
      1,
      relayWorkspaceId,
      "linear",
    );
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_linear",
        providerConfigKey: "linear-relay",
        method: "POST",
        endpoint: "/graphql",
      }),
    );
  });

  it("routes Google Mail label draft creates through the bridge fallback", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { id: "Label_123" },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "google-mail",
        connectionId: "conn_google_mail",
        providerConfigKey: "google-mail-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_google_mail_label_create",
      workspaceId: "ws_writeback",
      path: "/google-mail/labels/draft-20260521T094857Z.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "google-mail",
      content: JSON.stringify({
        name: "relayfile-writeback-test-20260521T094857Z",
        type: "user",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        textColor: "#ffffff",
        backgroundColor: "#fb4c2f",
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "google-mail",
      metadata: {
        action: "create_label",
        method: "POST",
        endpoint: "/gmail/v1/users/me/labels",
        externalId: "Label_123",
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenCalledWith(
      "ws_writeback",
      "google-mail",
    );
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_google_mail",
        providerConfigKey: "google-mail-relay",
        method: "POST",
        endpoint: "/gmail/v1/users/me/labels",
        data: {
          name: "relayfile-writeback-test-20260521T094857Z",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
          color: {
            textColor: "#ffffff",
            backgroundColor: "#fb4c2f",
          },
        },
      }),
    );
  });

  it("routes Jira issue creates through the adapter resolver and Nango proxy", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { id: "10000", key: "PROJ-1" },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira",
      workspaceId: "ws_writeback",
      path: "/jira/issues/new-ticket.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({
        fields: {
          project: { key: "PROJ" },
          summary: "Wire Jira writeback",
          issuetype: { name: "Task" },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "jira",
      metadata: {
        action: "create_issue",
        method: "POST",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue",
        externalId: "10000",
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenCalledWith(
      "ws_writeback",
      "jira",
    );
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        method: "POST",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue",
        data: {
          fields: {
            project: { key: "PROJ" },
            summary: "Wire Jira writeback",
            issuetype: { name: "Task" },
          },
        },
      }),
    );
  });

  it("routes Jira transitions through cloudId-scoped Nango proxy endpoints", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: {},
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_transition",
      workspaceId: "ws_writeback",
      path: "/jira/issues/ENG-42/transitions/create transition.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ transition: { id: "31" } }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "jira",
      metadata: {
        action: "transition_issue",
        method: "POST",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/ENG-42/transitions",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/ENG-42/transitions",
        data: { transition: { id: "31" } },
      }),
    );
  });

  it("routes Jira transitions from canonical slug/id issue segments", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: {},
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_transition_slug",
      workspaceId: "ws_writeback",
      path: "/jira/issues/tighten-retry-policy--10003/transitions/start-progress.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ transition: { id: "31" } }),
    });

    expect(result).toMatchObject({ outcome: "success" });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/10003/transitions",
      }),
    );
  });

  it("routes Jira issue edits from canonical slug/id records", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: {},
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_issue_edit_slug",
      workspaceId: "ws_writeback",
      path: "/jira/issues/relayfile-writeback-test-20260513t120136z__10035.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ fields: { description: "Edited through RelayFile" } }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "jira",
      metadata: {
        action: "update_issue",
        method: "PUT",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/10035",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        method: "PUT",
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/10035",
        data: { fields: { description: "Edited through RelayFile" } },
      }),
    );
  });

  it("routes Jira transitions from current double-underscore slug/id issue segments", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: {},
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_transition_slug_current",
      workspaceId: "ws_writeback",
      path: "/jira/issues/tighten-retry-policy__10003/transitions/start-progress.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ transition: { id: "31" } }),
    });

    expect(result).toMatchObject({ outcome: "success" });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/10003/transitions",
      }),
    );
  });

  it("falls back to Cloud's Jira transition parser for current double-underscore issue segments", async () => {
    vi.doMock("@relayfile/adapter-jira/writeback", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@relayfile/adapter-jira/writeback")>();
      return {
        ...actual,
        resolveJiraWritebackRequest: vi.fn(() => {
          throw new Error("adapter route missing");
        }),
      };
    });
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: {},
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_transition_fallback_slug_current",
      workspaceId: "ws_writeback",
      path: "/jira/issues/tighten-retry-policy__10003/transitions/start-progress.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ transition: { id: "31" } }),
    });

    expect(result).toMatchObject({ outcome: "success" });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/ex/jira/cloud-123/rest/api/3/issue/10003/transitions",
      }),
    );
  });

  it("routes Confluence page creates through the adapter resolver and Nango proxy", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { id: "98765" },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "confluence",
        connectionId: "conn_confluence",
        providerConfigKey: "confluence-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_confluence",
      workspaceId: "ws_writeback",
      path: "/confluence/spaces/688132/pages/create-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "confluence",
      content: JSON.stringify({
        title: "Wire Confluence writeback",
        body: "<p>Created by the writeback bridge.</p>",
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "confluence",
      metadata: {
        action: "create_page",
        method: "POST",
        endpoint: "/ex/confluence/cloud-123/wiki/api/v2/pages",
        externalId: "98765",
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenCalledWith(
      "ws_writeback",
      "confluence",
    );
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_confluence",
        providerConfigKey: "confluence-relay",
        method: "POST",
        endpoint: "/ex/confluence/cloud-123/wiki/api/v2/pages",
        data: {
          spaceId: "688132",
          status: "current",
          title: "Wire Confluence writeback",
          body: {
            representation: "storage",
            value: "<p>Created by the writeback bridge.</p>",
          },
        },
      }),
    );
  });

  it("routes Confluence page deletes through the adapter resolver and Nango proxy", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 204,
      headers: {},
      data: null,
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "confluence",
        connectionId: "conn_confluence",
        providerConfigKey: "confluence-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_confluence_delete",
      workspaceId: "ws_writeback",
      path: "/confluence/spaces/688132/pages/release-plan__98765.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "confluence",
      action: "file_delete",
      content: "",
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "confluence",
      metadata: {
        action: "delete_page",
        method: "DELETE",
        endpoint: "/ex/confluence/cloud-123/wiki/api/v2/pages/98765",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_confluence",
        providerConfigKey: "confluence-relay",
        method: "DELETE",
        endpoint: "/ex/confluence/cloud-123/wiki/api/v2/pages/98765",
      }),
    );
  });

  it("fails Confluence writeback when the connection lacks cloudId metadata", async () => {
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "confluence",
        connectionId: "conn_confluence",
        providerConfigKey: "confluence-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_confluence_no_cloud_id",
      workspaceId: "ws_writeback",
      path: "/confluence/spaces/688132/pages/create-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "confluence",
      content: JSON.stringify({ title: "No cloudId", body: "<p>x</p>" }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "confluence",
      error: { code: "integration_not_found" },
    });
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("rejects Jira transition issue segments with encoded path separators", async () => {
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: { connection_config: { cloudId: "cloud-123" } },
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_transition_bad_segment",
      workspaceId: "ws_writeback",
      path: "/jira/issues/ENG%2F42/transitions/start-progress.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({ transition: { id: "31" } }),
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "jira",
      error: {
        code: "unsupported_path",
        message: expect.stringContaining("encoded path separators"),
      },
    });
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("routes GitHub issue creates through the Nango proxy", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { id: 12345, number: 42 },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "github",
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_github_issue",
      workspaceId: "ws_writeback",
      path: "/github/repos/AgentWorkforce/cloud/issues/create request.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "github",
      content: JSON.stringify({
        title: "Wire file-native issue writes",
        body: "Created by the writeback bridge.",
        labels: ["deploy-v1"],
      }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "github",
      metadata: {
        action: "create_issue",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/issues",
        externalId: "12345",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/issues",
        data: {
          title: "Wire file-native issue writes",
          body: "Created by the writeback bridge.",
          labels: ["deploy-v1"],
        },
      }),
    );
  });

  it("routes GitHub issue comment creates without the PR review-comment branch", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { id: 98765 },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "github",
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_github_issue_comment",
      workspaceId: "ws_writeback",
      path: "/github/repos/AgentWorkforce/cloud/issues/42/comments/create comment.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "github",
      content: JSON.stringify({ body: "Tracking this from the agent." }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "github",
      metadata: {
        action: "create_issue_comment",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/issues/42/comments",
        externalId: "98765",
      },
    });
  });

  it("routes GitHub issue label additions through the additive labels endpoint", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: [{ id: 1, name: "merge-on-green" }],
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "github",
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_github_issue_label",
      workspaceId: "ws_writeback",
      path: "/github/repos/AgentWorkforce/cloud/issues/42/labels/merge-on-green.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "github",
      content: JSON.stringify({ labels: ["merge-on-green"] }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "github",
      metadata: {
        action: "add_issue_labels",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/issues/42/labels",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/issues/42/labels",
        data: { labels: ["merge-on-green"] },
      }),
    );
  });

  it("routes GitHub review comments from slugged pull directories", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { id: 123456 },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "github",
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_github_review_comment",
      workspaceId: "ws_writeback",
      path: "/github/repos/AgentWorkforce/cloud/pulls/42__deploy-v1/comments/create comment.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "github",
      content: JSON.stringify({
        body: "Please check this branch.",
        commit_id: "abc123",
        path: "src/index.ts",
        line: 12,
      }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      metadata: {
        action: "create_review_comment",
        endpoint: "/repos/AgentWorkforce/cloud/pulls/42/comments",
      },
    });
  });

  it("routes GitHub pull request review creates", async () => {
    proxyMock.mockResolvedValueOnce({
      status: 201,
      headers: {},
      data: { id: 456789 },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "github",
        connectionId: "conn_github",
        providerConfigKey: "github-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_github_pull_review",
      workspaceId: "ws_writeback",
      path: "/github/repos/AgentWorkforce/cloud/pulls/42/reviews/create review.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "github",
      content: JSON.stringify({
        event: "COMMENT",
        body: "Formal review submitted by pr-reviewer.",
        comments: [],
      }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "github",
      metadata: {
        action: "create_review",
        method: "POST",
        endpoint: "/repos/AgentWorkforce/cloud/pulls/42/reviews",
        externalId: "456789",
      },
    });
    expect(proxyMock).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/repos/AgentWorkforce/cloud/pulls/42/reviews",
      data: {
        event: "COMMENT",
        body: "Formal review submitted by pr-reviewer.",
        comments: [],
      },
    }));
  });

  it("routes Slack direct messages as conversations.open then chat.postMessage", async () => {
    proxyMock
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { ok: true, channel: { id: "D12345" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { ok: true, ts: "1713220123.001100" },
      });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_slack_dm",
      workspaceId: "ws_writeback",
      path: "/slack/users/U01ABC1234/messages/create request.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "slack",
      content: JSON.stringify({ text: "Can you review this?", unfurl_links: false }),
    });

    expect(result).toMatchObject({
      outcome: "success",
      provider: "slack",
      metadata: {
        action: "post_dm",
        endpoint: "/chat.postMessage",
        externalId: "1713220123.001100",
      },
    });
    expect(proxyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        endpoint: "/conversations.open",
        data: { users: "U01ABC1234", return_im: true },
      }),
    );
    expect(proxyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        endpoint: "/chat.postMessage",
        data: { text: "Can you review this?", unfurl_links: false, channel: "D12345" },
      }),
    );
  });

  it("rejects read-only fields in Slack direct message payloads", async () => {
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_slack_dm_readonly",
      workspaceId: "ws_writeback",
      path: "/slack/users/U01ABC1234/messages/create.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "slack",
      content: JSON.stringify({ id: "D1", text: "Nope" }),
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "slack",
      error: {
        code: "unsupported_path",
        message: expect.stringContaining("read-only field id"),
      },
    });
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("rejects Jira writeback before proxying when cloudId metadata is absent", async () => {
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration({
        provider: "jira",
        connectionId: "conn_jira",
        providerConfigKey: "jira-relay",
        metadata: {},
      }),
    );
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_jira_missing_cloud",
      workspaceId: "ws_writeback",
      path: "/jira/issues/new-ticket.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "jira",
      content: JSON.stringify({
        fields: {
          project: { key: "PROJ" },
          summary: "Wire Jira writeback",
          issuetype: { name: "Task" },
        },
      }),
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "jira",
      error: { code: "integration_not_found" },
    });
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("rejects mismatches between provider input and path prefix", async () => {
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_mismatch",
      workspaceId: "ws_writeback",
      path: "/notion/pages/page-1.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "linear",
      content: "{}",
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "notion",
      error: { code: "provider_mismatch" },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("rejects Dropbox writeback because Dropbox mount is metadata-only", async () => {
    const { executeRelayfileProviderWriteback } = await loadBridge();

    const result = await executeRelayfileProviderWriteback({
      opId: "op_dropbox_writeback",
      workspaceId: "ws_writeback",
      path: "/dropbox/files/by-id/id%3Aabc123.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "dropbox",
      content: JSON.stringify({ name: "rename-attempt.txt" }),
    });

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "dropbox",
      error: {
        code: "unsupported_path",
        message: expect.stringContaining("metadata-only"),
      },
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
  });
});

describe("relayfile writeback ack idempotency and retry", () => {
  function buildNotionWritebackInput() {
    return {
      opId: "op_ack_test",
      workspaceId: "ws_writeback",
      path: "/notion/databases/db-1/pages/new-page.json",
      revision: "rev_1",
      correlationId: "corr_1",
      provider: "notion",
      content: JSON.stringify({
        properties: {
          Name: { title: [{ text: { content: "Updated" } }] },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    };
  }

  function ackResponse(status: number, body = "") {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response;
  }

  function buildSuccessReceipt() {
    return {
      workspaceId: "ws_writeback",
      opId: "op_ack_test",
      provider: "notion",
      outcome: "success" as const,
      errorCode: null,
      errorMessage: null,
      metadata: {
        provider: "notion",
        action: "create_page",
        externalId: "page-1",
      },
      ackedAt: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    getProviderConfigKeyMock.mockImplementation(
      (provider: string) => `${provider}-default`,
    );
    getNangoClientMock.mockReturnValue({ proxy: proxyMock });
    proxyMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { id: "page-1" },
    });
    getWorkspaceIntegrationByProviderAliasMock.mockResolvedValue(
      buildIntegration(),
    );
    resolveWorkspaceIntegrationIdentityMock.mockImplementation(
      async (workspaceId: string) => mockSingleWorkspaceIdentity(workspaceId),
    );
    findReceiptMock.mockResolvedValue(null);
    recordReceiptMock.mockResolvedValue(undefined);
    markReceiptAckedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps relayfile ACKs addressed to the enqueued workspace id after resolving credentials through the relay id", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const relayWorkspaceId = "rw_7ccfea89";
    resolveWorkspaceIntegrationIdentityMock.mockResolvedValueOnce({
      requestedWorkspaceId: appWorkspaceId,
      appWorkspaceId,
      relayWorkspaceId,
      organizationId: "org_123",
      candidateWorkspaceIds: [appWorkspaceId, relayWorkspaceId],
    });
    getWorkspaceIntegrationByProviderAliasMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildIntegration({
          workspaceId: relayWorkspaceId,
          provider: "notion",
          connectionId: "conn_notion",
          providerConfigKey: "notion-relay",
        }),
      );
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      {
        ...buildNotionWritebackInput(),
        opId: "op_app_uuid_ack",
        workspaceId: appWorkspaceId,
      },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "success",
      relayfileAcked: true,
    });
    expect(getWorkspaceIntegrationByProviderAliasMock).toHaveBeenNthCalledWith(
      1,
      relayWorkspaceId,
      "notion",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/v1/workspaces/${encodeURIComponent(appWorkspaceId)}/writeback/op_app_uuid_ack/ack`,
    );
    expect(markReceiptAckedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: appWorkspaceId,
        opId: "op_app_uuid_ack",
      }),
    );
  });

  it("retries a transient ack failure in-process without re-dispatching the provider op", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ackResponse(502, "bad gateway"))
      .mockResolvedValueOnce(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const resultPromise = handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await vi.advanceTimersByTimeAsync(250);
    const result = await resultPromise;

    expect(result).toMatchObject({
      outcome: "success",
      provider: "notion",
      relayfileAcked: true,
    });
    // Provider op dispatched exactly once; only the ack was retried.
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markReceiptAckedMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_writeback", opId: "op_ack_test" }),
    );
  });

  it("persists a receipt before acking and reports relayfile_ack_failed when the ack budget is exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(503, "relayfile down"));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const resultPromise = handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    // Drain all in-process backoff delays (250 + 500 + 1000ms).
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toMatchObject({
      outcome: "retryable_failure",
      provider: "notion",
      error: {
        code: "relayfile_ack_failed",
        message: expect.stringContaining("503"),
      },
      relayfileAcked: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    // The receipt was recorded before the ack attempts, so the relayfile-driven
    // retry can detect that only the ack is owed.
    expect(recordReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_writeback",
        opId: "op_ack_test",
        provider: "notion",
        outcome: "success",
      }),
    );
    expect(markReceiptAckedMock).not.toHaveBeenCalled();
  });

  it("acks-only on retry after recovery when the provider op already applied", async () => {
    findReceiptMock.mockResolvedValue(buildSuccessReceipt());
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "success",
      provider: "notion",
      metadata: {
        action: "create_page",
        externalId: "page-1",
      },
      relayfileAcked: true,
    });
    // The provider op was NOT re-dispatched: no integration lookup, no proxy.
    expect(getWorkspaceIntegrationByProviderAliasMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No duplicate receipt write for an already-recorded op.
    expect(recordReceiptMock).not.toHaveBeenCalled();
    expect(markReceiptAckedMock).toHaveBeenCalledTimes(1);
  });

  it("replays a recorded permanent failure as an ack-only failure ack on retry", async () => {
    findReceiptMock.mockResolvedValue({
      ...buildSuccessReceipt(),
      outcome: "permanent_failure" as const,
      errorCode: "invalid_content",
      errorMessage: "Notion rejected the payload",
      metadata: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      provider: "notion",
      error: {
        code: "invalid_content",
        message: "Notion rejected the payload",
      },
      relayfileAcked: true,
    });
    expect(proxyMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, ackInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(ackInit.body))).toMatchObject({
      success: false,
      error: "Notion rejected the payload",
    });
  });

  it("does not retry a permanent (4xx) ack failure and surfaces it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(401, "unauthorized"));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "retryable_failure",
      provider: "notion",
      error: {
        code: "relayfile_ack_failed",
        message: expect.stringContaining("401"),
      },
      relayfileAcked: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markReceiptAckedMock).not.toHaveBeenCalled();
  });

  it("treats a 404 ack response as already-acknowledged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ackResponse(404, "not found"));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "success",
      relayfileAcked: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects exponential backoff between ack retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ackResponse(503))
      .mockResolvedValueOnce(ackResponse(503))
      .mockResolvedValueOnce(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const resultPromise = handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    // First attempt happens without any delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second attempt waits the full 250ms base delay.
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third attempt doubles the delay to 500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const result = await resultPromise;
    expect(result).toMatchObject({ outcome: "success", relayfileAcked: true });
  });

  it("retries network-level ack failures as transient", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ackResponse(200));
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const resultPromise = handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await vi.advanceTimersByTimeAsync(250);
    const result = await resultPromise;

    expect(result).toMatchObject({ outcome: "success", relayfileAcked: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not ack or persist receipts for retryable provider failures", async () => {
    proxyMock.mockResolvedValue({
      status: 429,
      headers: {},
      data: null,
    });
    const fetchMock = vi.fn();
    const { handleRelayfileProviderWriteback } = await loadBridge();

    const result = await handleRelayfileProviderWriteback(
      buildNotionWritebackInput(),
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "retryable_failure",
      relayfileAcked: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordReceiptMock).not.toHaveBeenCalled();
  });
});
