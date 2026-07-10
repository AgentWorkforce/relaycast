import { describe, expect, it, vi } from "vitest";
import { resolveConfluenceWritebackRequest } from "@relayfile/adapter-confluence/writeback";
import { resolveWritebackRequest as resolveGitHubWritebackRequest } from "@relayfile/adapter-github/writeback";
import { resolveJiraWritebackRequest } from "@relayfile/adapter-jira/writeback";
import {
  resolveDeleteRequest as resolveLinearDeleteRequest,
  resolveWritebackRequest as resolveLinearWritebackRequest,
} from "@relayfile/adapter-linear/writeback";
import { resolveWritebackRequest as resolveNotionWritebackRequest } from "@relayfile/adapter-notion/writeback";
import { resolveWritebackRequest as resolveSlackWritebackRequest } from "@relayfile/adapter-slack/writeback";
import { dispatchProviderWriteback } from "../src/writeback/providers/index.js";
import type {
  IntegrationCredential,
  WritebackInput,
  WritebackProvider,
} from "../src/writeback/types.js";

type CapturedNangoCall = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: unknown;
};

const BASE_INPUT = {
  opId: "op_provider_parity",
  workspaceId: "ws_provider_parity",
  revision: "rev_provider_parity",
  correlationId: "corr_provider_parity",
  action: "file_upsert",
  contentType: "application/json",
  encoding: "utf-8",
} as const;

function credential(
  provider: WritebackProvider,
  aliasFields: Record<string, unknown> = {},
): IntegrationCredential {
  return {
    provider,
    providerConfigKey: `${provider}-relay`,
    connectionId: `conn_${provider}`,
    aliasFields,
    writebackDispatchVia: "cf",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

function captureFetch(responseBody: unknown) {
  const calls: CapturedNangoCall[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body:
          init?.body === undefined
            ? undefined
            : (JSON.parse(String(init.body)) as unknown),
      });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return { calls, fetchImpl };
}

type SlackIdempotencyRow = {
  key: string;
  status: string;
  external_id: string | null;
  expires_at: string;
  updated_at: string;
};

function createSlackIdempotencyDb() {
  const rows = new Map<string, SlackIdempotencyRow>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (
                /^INSERT OR IGNORE INTO slack_writeback_idempotency/i.test(sql)
              ) {
                const key = String(values[0]);
                if (rows.has(key)) {
                  return { success: true, meta: { changes: 0 } };
                }
                rows.set(key, {
                  key,
                  status: String(values[8]),
                  external_id: null,
                  expires_at: String(values[10]),
                  updated_at: String(values[11]),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (/^UPDATE slack_writeback_idempotency/i.test(sql)) {
                const externalId = values[0] == null ? null : String(values[0]);
                const key = String(values[3]);
                const row = rows.get(key);
                if (row) {
                  row.status = String(values[2]);
                  row.external_id = externalId;
                  row.updated_at = String(values[1]);
                }
                return { success: true, meta: { changes: row ? 1 : 0 } };
              }
              if (/^DELETE FROM slack_writeback_idempotency/i.test(sql)) {
                const key = String(values[0]);
                const row = rows.get(key);
                let deleted = false;
                if (sql.includes("expires_at <= ?")) {
                  if (row && row.expires_at <= String(values[1])) {
                    deleted = rows.delete(key);
                  }
                } else if (sql.includes("status = 'pending'")) {
                  if (row?.status === "pending") {
                    deleted = rows.delete(key);
                  }
                } else {
                  deleted = rows.delete(key);
                }
                return { success: true, meta: { changes: deleted ? 1 : 0 } };
              }
              throw new Error(`Unexpected D1 run SQL: ${sql}`);
            },
            async first() {
              if (
                /^SELECT status, external_id, expires_at, updated_at FROM slack_writeback_idempotency/i.test(
                  sql,
                )
              ) {
                const row = rows.get(String(values[0]));
                return row
                  ? {
                      status: row.status,
                      external_id: row.external_id,
                      expires_at: row.expires_at,
                      updated_at: row.updated_at,
                    }
                  : null;
              }
              throw new Error(`Unexpected D1 first SQL: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return {
    db,
    rows,
    expireAll() {
      for (const row of rows.values()) {
        row.expires_at = "2000-01-01T00:00:00.000Z";
      }
    },
    markAllPending(updatedAt: string) {
      for (const row of rows.values()) {
        row.status = "pending";
        row.external_id = null;
        row.updated_at = updatedAt;
      }
    },
  };
}

describe("Cloudflare-native writeback provider dispatch parity", () => {
  it("dispatches Notion through Nango using the adapter request", async () => {
    const path =
      "/notion/databases/db-1/pages/11111111-1111-4111-8111-111111111112.json";
    const content = JSON.stringify({
      properties: {
        Name: { id: "title", type: "title", value: "Updated by Worker" },
      },
    });
    const expected = resolveNotionWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({ id: "page-1" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "notion",
        path,
        content,
      } satisfies WritebackInput,
      credential("notion", { notionApiVersion: "2022-06-28" }),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: JSON.parse(JSON.stringify(expected.body)) as unknown,
    });
    expect(calls[0]?.headers.get("notion-version")).toBe("2022-06-28");
  });

  it("dispatches GitHub through Nango using the adapter request", async () => {
    const path =
      "/github/repos/AgentWorkforce/cloud/issues/create request.json";
    const content = JSON.stringify({
      title: "Wire file-native issue writes",
      body: "Created by the Cloudflare writeback dispatcher.",
      labels: ["deploy-v1"],
    });
    const expected = resolveGitHubWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({ id: 12345 });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "github",
        path,
        content,
      } satisfies WritebackInput,
      credential("github"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it("dispatches Google Mail label drafts through Nango as label creates", async () => {
    const path = "/google-mail/labels/draft-20260521T094857Z.json";
    const content = JSON.stringify({
      name: "relayfile-writeback-test-20260521T094857Z",
      type: "user",
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
      textColor: "#ffffff",
      backgroundColor: "#fb4c2f",
    });
    const { calls, fetchImpl } = captureFetch({ id: "Label_123" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "google-mail",
        path,
        content,
      } satisfies WritebackInput,
      credential("google-mail"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "success",
      providerObjectId: "Label_123",
      metadata: {
        provider: "google-mail",
        action: "create_label",
        method: "POST",
        endpoint: "/gmail/v1/users/me/labels",
        status: 200,
        externalId: "Label_123",
      },
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/gmail/v1/users/me/labels",
      method: "POST",
      body: {
        name: "relayfile-writeback-test-20260521T094857Z",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        color: {
          textColor: "#ffffff",
          backgroundColor: "#fb4c2f",
        },
      },
    });
  });

  it("dispatches Google Mail filter drafts through Nango as filter creates", async () => {
    const path = "/google-mail/filters/draft-route-alerts.json";
    const content = JSON.stringify({
      from: "alerts@example.com",
      subject: "Incident",
      addLabelIds: ["Label_123"],
      removeLabelIds: ["INBOX"],
    });
    const { calls, fetchImpl } = captureFetch({ id: "filter-123" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "google-mail",
        path,
        content,
      } satisfies WritebackInput,
      credential("google-mail"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/gmail/v1/users/me/settings/filters",
      method: "POST",
      body: {
        criteria: {
          from: "alerts@example.com",
          subject: "Incident",
        },
        action: {
          addLabelIds: ["Label_123"],
          removeLabelIds: ["INBOX"],
        },
      },
    });
  });

  it("dispatches Google Mail send-as drafts through Nango as alias creates", async () => {
    const path = "/google-mail/send-as/draft-support-alias.json";
    const content = JSON.stringify({
      sendAsEmail: "support@example.com",
      displayName: "Support",
      replyToAddress: "help@example.com",
      treatAsAlias: true,
    });
    const { calls, fetchImpl } = captureFetch({
      sendAsEmail: "support@example.com",
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "google-mail",
        path,
        content,
      } satisfies WritebackInput,
      credential("google-mail"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/gmail/v1/users/me/settings/sendAs",
      method: "POST",
      body: {
        sendAsEmail: "support@example.com",
        displayName: "Support",
        replyToAddress: "help@example.com",
        treatAsAlias: true,
      },
    });
  });

  it("dispatches Google Mail message drafts through Nango as message sends", async () => {
    const path = "/google-mail/messages/draft-status-update.json";
    const content = JSON.stringify({
      raw: "RnJvbTogbWVAZXhhbXBsZS5jb20KVG86IHlvdUBleGFtcGxlLmNvbQoKU2VudA",
      threadId: "thread-123",
    });
    const { calls, fetchImpl } = captureFetch({
      id: "msg-123",
      threadId: "thread-123",
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "google-mail",
        path,
        content,
      } satisfies WritebackInput,
      credential("google-mail"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/gmail/v1/users/me/messages/send",
      method: "POST",
      body: {
        raw: "RnJvbTogbWVAZXhhbXBsZS5jb20KVG86IHlvdUBleGFtcGxlLmNvbQoKU2VudA",
        threadId: "thread-123",
      },
    });
  });

  it("dispatches Linear through Nango using the adapter request", async () => {
    const path = "/linear/issues/create request.json";
    const content = JSON.stringify({
      teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
      title: "Worker parity smoke test",
      description: "Created from the Cloudflare writeback dispatcher.",
    });
    const expected = resolveLinearWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-uuid-1" },
        },
      },
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "linear",
        path,
        content,
      } satisfies WritebackInput,
      credential("linear"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it("dispatches Linear agent activities through Nango using the adapter request", async () => {
    const path =
      "/linear/agent-sessions/session_linear_123/activities/agent-activities-reply.json";
    const content = JSON.stringify({
      type: "response",
      body: "I can help with that.",
    });
    const expected = resolveLinearWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({
      data: {
        agentActivityCreate: {
          success: true,
        },
      },
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "linear",
        path,
        content,
      } satisfies WritebackInput,
      credential("linear"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it.each([
    {
      name: "create",
      action: "file_upsert" as const,
      path: "/linear/labels/new-label.json",
      content: JSON.stringify({ name: "Escalation", color: "#bec2c8" }),
      responseBody: {
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: "label-uuid-1", name: "Escalation" },
          },
        },
      },
      providerObjectId: "label-uuid-1",
    },
    {
      name: "update",
      action: "file_upsert" as const,
      path: "/linear/labels/escalation__11111111-1111-4111-8111-111111111111.json",
      content: JSON.stringify({ name: "Escalation", color: "#f2c94c" }),
      responseBody: {
        data: {
          issueLabelUpdate: {
            success: true,
            issueLabel: {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Escalation",
            },
          },
        },
      },
      providerObjectId: "11111111-1111-4111-8111-111111111111",
    },
    {
      name: "delete",
      action: "file_delete" as const,
      path: "/linear/labels/escalation__11111111-1111-4111-8111-111111111111.json",
      content: "",
      responseBody: {
        data: {
          issueLabelDelete: {
            success: true,
          },
        },
      },
      providerObjectId: "11111111-1111-4111-8111-111111111111",
    },
  ])(
    "dispatches Linear label $name through Nango using the adapter request",
    async ({ action, path, content, responseBody, providerObjectId }) => {
      const expected =
        action === "file_delete"
          ? resolveLinearDeleteRequest(path)
          : resolveLinearWritebackRequest(path, content);
      const { calls, fetchImpl } = captureFetch(responseBody);

      const result = await dispatchProviderWriteback(
        {
          ...BASE_INPUT,
          action,
          provider: "linear",
          path,
          content,
        } satisfies WritebackInput,
        credential("linear"),
        {
          NANGO_SECRET_KEY: "nango-secret",
          NANGO_BASE_URL: "https://api.nango.test",
        },
        { fetchImpl: fetchImpl as typeof fetch },
      );

      expect(result).toMatchObject({
        outcome: "success",
        providerObjectId,
        metadata: {
          provider: "linear",
          action: expected.action,
          method: expected.method,
          endpoint: expected.endpoint,
          status: 200,
          externalId: providerObjectId,
        },
      });
      expect(calls[0]).toMatchObject({
        url: `https://api.nango.test/proxy${expected.endpoint}`,
        method: expected.method,
        body: expected.body,
      });
    },
  );

  it("extracts Linear project ids from Nango action responses", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const path = `/linear/projects/${projectId}/meta.json`;
    const content = JSON.stringify({ name: "Roadmap v2" });
    const expected = resolveLinearWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({
      id: projectId,
      name: "Roadmap v2",
      state: "planned",
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "linear",
        path,
        content,
      } satisfies WritebackInput,
      credential("linear"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "success",
      providerObjectId: projectId,
      metadata: {
        provider: "linear",
        action: "update-project",
        method: "PATCH",
        endpoint: expected.endpoint,
        status: 200,
        externalId: projectId,
      },
    });
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it("reports Linear add-issues-to-project partial failures from Nango action responses", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const path = `/linear/projects/${projectId}/add-issues.json`;
    const content = JSON.stringify({ issueIds: ["issue-1", "issue-2"] });
    const { fetchImpl } = captureFetch({
      results: [
        { issueId: "issue-1", success: true },
        { issueId: "issue-2", success: false, error: "team mismatch" },
      ],
    });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "linear",
        path,
        content,
      } satisfies WritebackInput,
      credential("linear"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toMatchObject({
      outcome: "permanent_failure",
      error: "team mismatch",
      metadata: {
        provider: "linear",
        action: "add-issues-to-project",
        method: "POST",
        status: 200,
      },
    });
  });

  it("dispatches Jira through Nango using the adapter request and cloud id", async () => {
    const path = "/jira/issues/new-ticket.json";
    const content = JSON.stringify({
      fields: {
        project: { key: "PROJ" },
        summary: "Wire Jira writeback",
        issuetype: { name: "Task" },
      },
    });
    const expected = resolveJiraWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({ id: "10000", key: "PROJ-1" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "jira",
        path,
        content,
      } satisfies WritebackInput,
      credential("jira", { connection_config: { cloudId: "cloud-123" } }),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy/ex/jira/cloud-123${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it("dispatches Jira transition fallback with a current slugged canonical issue id", async () => {
    const path =
      "/jira/issues/tighten-retry-policy__10003/transitions/apply.json";
    const content = JSON.stringify({ transition: { id: "31" } });
    const { calls, fetchImpl } = captureFetch({ id: "10003", key: "PROJ-1" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "jira",
        path,
        content,
      } satisfies WritebackInput,
      credential("jira", { connection_config: { cloudId: "cloud-123" } }),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/ex/jira/cloud-123/rest/api/3/issue/10003/transitions",
      method: "POST",
      body: { transition: { id: "31" } },
    });
  });

  it("dispatches Confluence through Nango using the adapter request", async () => {
    const path = "/confluence/spaces/688132/pages/create-page.json";
    const content = JSON.stringify({
      title: "Wire Confluence writeback",
      body: "<p>Created by the Cloudflare writeback dispatcher.</p>",
    });
    const expected = resolveConfluenceWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({ id: "98765" });

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "confluence",
        path,
        content,
      } satisfies WritebackInput,
      credential("confluence"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint}`,
      method: expected.method,
      body: expected.body,
    });
  });

  it("dispatches Slack through Nango using the adapter request", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const content = JSON.stringify({ text: "Posting from the Worker" });
    const expected = resolveSlackWritebackRequest(path, content);
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001100",
      channel: "C0CUSTSUCCESS",
    });
    const { db } = createSlackIdempotencyDb();

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
        DB: db,
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls[0]).toMatchObject({
      url: `https://api.nango.test/proxy${expected.endpoint.replace(/^\/api/, "")}`,
      method: expected.method,
      body: expected.body,
    });
    // The Slack message ts is surfaced as the providerObjectId and aliased on
    // metadata as `ts`/`channel`, so it lands on the op's providerResult and an
    // agent can use it as thread_ts for a threaded reply.
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.providerObjectId).toBe("1713220123.001100");
    expect(result.metadata?.ts).toBe("1713220123.001100");
    expect(result.metadata?.channel).toBe("C0CUSTSUCCESS");
  });

  it("deduplicates repeated Slack chat.postMessage writebacks across opIds and revisions", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const content = JSON.stringify({ text: "Posting once from retries" });
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001200",
    });
    const { db } = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: db,
    };

    const first = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_retry_1",
        revision: "rev_1",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    const second = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_retry_2",
        revision: "rev_2",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("success");
    if (first.outcome !== "success" || second.outcome !== "success") {
      throw new Error("Expected both Slack writebacks to succeed");
    }
    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(calls).toHaveLength(1);
    // The deduplicated success must still satisfy the providerResult contract
    // so an agent can thread a reply after a replayed/idempotent post.
    expect(second.metadata?.idempotencyDuplicate).toBe(true);
    expect(second.metadata?.ts).toBe("1713220123.001200");
    expect(second.metadata?.channel).toBe("C0CUSTSUCCESS");
  });

  it("does not deduplicate distinct Slack message bodies", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001300",
    });
    const { db } = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: db,
    };

    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_distinct_1",
        revision: "rev_distinct_1",
        provider: "slack",
        path,
        content: JSON.stringify({ text: "First message" }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_distinct_2",
        revision: "rev_distinct_2",
        provider: "slack",
        path,
        content: JSON.stringify({ text: "Second message" }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(calls).toHaveLength(2);
  });

  it("deduplicates a re-run with drifting content when the client idempotencyKey matches", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.009000",
    });
    const { db } = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: db,
    };

    const first = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_idem_match_1",
        revision: "rev_1",
        provider: "slack",
        path,
        content: JSON.stringify({
          text: "3 tweets worth responding to",
          idempotencyKey: "tick:delivery-42:1",
        }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    // A duplicate run of the same tick regenerates DIFFERENT content (the count
    // drifted) but carries the SAME client idempotency token. Content-hash dedup
    // would post twice; keying on the token collapses it to one.
    const second = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_idem_match_2",
        revision: "rev_2",
        provider: "slack",
        path,
        content: JSON.stringify({
          text: "5 tweets worth responding to",
          idempotencyKey: "tick:delivery-42:1",
        }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("success");
    expect(calls).toHaveLength(1);
    expect(second.metadata?.idempotencyDuplicate).toBe(true);
  });

  it("does not deduplicate distinct client idempotencyKeys for identical content", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.009100",
    });
    const { db } = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: db,
    };

    // Two distinct messages in one tick (e.g. header then a follow-up) share the
    // same channel + content shape but get distinct ordinals. Content-hash dedup
    // would wrongly collapse them; distinct tokens keep them apart.
    const body = { text: "same text, different message slot" };
    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_idem_distinct_1",
        revision: "rev_1",
        provider: "slack",
        path,
        content: JSON.stringify({ ...body, idempotencyKey: "tick:delivery-42:1" }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_idem_distinct_2",
        revision: "rev_2",
        provider: "slack",
        path,
        content: JSON.stringify({ ...body, idempotencyKey: "tick:delivery-42:2" }),
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(calls).toHaveLength(2);
  });

  it("reclaims stale pending Slack idempotency claims and posts again", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const content = JSON.stringify({ text: "Posting after stale pending" });
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001350",
    });
    const dedup = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: dedup.db,
    };

    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_pending_seed",
        revision: "rev_pending_seed",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    calls.length = 0;
    dedup.markAllPending("2000-01-01T00:00:00.000Z");

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_pending_retry",
        revision: "rev_pending_retry",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls).toHaveLength(1);
  });

  it("suppresses fresh pending Slack idempotency claims as in-flight duplicates", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const content = JSON.stringify({ text: "Posting while pending" });
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001360",
    });
    const dedup = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: dedup.db,
    };

    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_fresh_pending_seed",
        revision: "rev_fresh_pending_seed",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    calls.length = 0;
    dedup.markAllPending(new Date().toISOString());

    const result = await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_fresh_pending_retry",
        revision: "rev_fresh_pending_retry",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.outcome).toBe("success");
    expect(calls).toHaveLength(0);
  });

  it("allows a Slack logical post after the idempotency window expires", async () => {
    const path =
      "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json";
    const content = JSON.stringify({ text: "Posting after window" });
    const { calls, fetchImpl } = captureFetch({
      ok: true,
      ts: "1713220123.001400",
    });
    const dedup = createSlackIdempotencyDb();
    const env = {
      NANGO_SECRET_KEY: "nango-secret",
      NANGO_BASE_URL: "https://api.nango.test",
      DB: dedup.db,
    };

    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_window_1",
        revision: "rev_window_1",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    dedup.expireAll();
    await dispatchProviderWriteback(
      {
        ...BASE_INPUT,
        opId: "op_slack_window_2",
        revision: "rev_window_2",
        provider: "slack",
        path,
        content,
      } satisfies WritebackInput,
      credential("slack"),
      env,
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(calls).toHaveLength(2);
  });
});
