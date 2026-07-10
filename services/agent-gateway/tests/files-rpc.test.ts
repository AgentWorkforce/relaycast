import assert from "node:assert/strict";
import { test } from "vitest";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import { RelayFileApiError } from "@relayfile/sdk";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("gateway proxies ctx.files RPCs through the websocket control channel", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const writes: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const listCalls: Array<Record<string, unknown>> = [];

  gateway["resolveRelayfileSession"] = async () =>
    ({
      workspace: "support",
      client: {
        async readFile(_workspace: string, path: string) {
          if (path === "/docs/missing.md") {
            throw new RelayFileApiError(404, {
              code: "not_found",
              message: "file not found",
            });
          }

          return {
            path,
            revision: "rev-read-1",
            contentType: "text/markdown",
            content: "# Readme",
            encoding: "utf-8",
          };
        },
        async writeFile(input: Record<string, unknown>) {
          writes.push(input);
          return {
            opId: "op-write-1",
            status: "queued",
            targetRevision: "rev-write-1",
          };
        },
        async deleteFile(input: Record<string, unknown>) {
          deletes.push(input);
          return {
            opId: "op-delete-1",
            status: "queued",
            targetRevision: "rev-delete-1",
          };
        },
        async queryFiles(_workspace: string, options: Record<string, unknown>) {
          listCalls.push(options);
          const cursor = typeof options.cursor === "string" ? options.cursor : undefined;
          if (!cursor) {
            return {
              items: [
                { path: "/docs/readme.md", revision: "rev-list-1", size: 7 },
                { path: "/docs/ignore.txt", revision: "rev-list-2", size: 9 },
              ],
              nextCursor: "page-2",
            };
          }

          return {
            items: [
              { path: "/docs/guide.md", revision: "rev-list-3", size: 11 },
            ],
            nextCursor: null,
          };
        },
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "files_read",
    requestId: "read-1",
    path: "/docs/readme.md",
  }));
  const readResult = await waitForMessage(messages, 0);
  assert.deepEqual(readResult, {
    type: "files_read_result",
    requestId: "read-1",
    file: {
      path: "/docs/readme.md",
      revision: "rev-read-1",
      contentType: "text/markdown",
      content: "# Readme",
      encoding: "utf-8",
    },
  });

  client.send(JSON.stringify({
    type: "files_read",
    requestId: "read-404",
    path: "/docs/missing.md",
  }));
  const missingReadResult = await waitForMessage(messages, 1);
  assert.deepEqual(missingReadResult, {
    type: "files_read_result",
    requestId: "read-404",
    file: null,
  });

  client.send(JSON.stringify({
    type: "files_write",
    requestId: "write-1",
    path: "/docs/state.json",
    body: { ok: true },
    meta: {
      semantics: {
        properties: {
          status: "open",
        },
      },
      contentIdentity: {
        kind: "event",
        key: "evt-123",
      },
    },
  }));
  const writeResult = await waitForMessage(messages, 2);
  assert.deepEqual(writeResult, {
    type: "files_write_result",
    requestId: "write-1",
  });
  assert.deepEqual(writes, [
    {
      workspaceId: "support",
      path: "/docs/state.json",
      baseRevision: "*",
      content: "{\"ok\":true}",
      contentType: "application/json",
      encoding: "utf-8",
      semantics: {
        properties: {
          status: "open",
        },
      },
      contentIdentity: {
        kind: "event",
        key: "evt-123",
      },
    },
  ]);

  client.send(JSON.stringify({
    type: "files_delete",
    requestId: "delete-1",
    path: "/docs/state.json",
  }));
  const deleteResult = await waitForMessage(messages, 3);
  assert.deepEqual(deleteResult, {
    type: "files_delete_result",
    requestId: "delete-1",
  });
  assert.deepEqual(deletes, [
    {
      workspaceId: "support",
      path: "/docs/state.json",
      baseRevision: "*",
    },
  ]);

  client.send(JSON.stringify({
    type: "files_list",
    requestId: "list-1",
    glob: "/docs/*.md",
  }));
  const listResult = await waitForMessage(messages, 4);
  assert.deepEqual(listResult, {
    type: "files_list_result",
    requestId: "list-1",
    entries: [
      { path: "/docs/readme.md", revision: "rev-list-1", size: 7 },
      { path: "/docs/guide.md", revision: "rev-list-3", size: 11 },
    ],
  });
  assert.deepEqual(listCalls, [
    {
      path: "/docs",
      cursor: undefined,
      limit: 1_000,
    },
    {
      path: "/docs",
      cursor: "page-2",
      limit: 1_000,
    },
  ]);
});

test("gateway rejects out-of-scope file writes for path-scoped agent tokens", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const writes: Array<Record<string, unknown>> = [];
  gateway["resolveRelayfileSession"] = async () =>
    ({
      workspace: "support",
      pathGlobs: ["/docs/allowed/**"],
      client: {
        async writeFile(input: Record<string, unknown>) {
          writes.push(input);
          return {
            opId: "op-write-1",
            status: "queued",
            targetRevision: "rev-write-1",
          };
        },
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: createJwt({
      sub: "agent-1",
      scopes: ["relayfile:fs:write:/docs/allowed/**"],
      meta: {
        pathGlobs: JSON.stringify(["/docs/allowed/**"]),
      },
    }),
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "files_write",
    requestId: "write-denied",
    path: "/docs/private/state.json",
    body: { ok: false },
  }));

  assert.deepEqual(await waitForMessage(messages, 0), {
    type: "files_error",
    requestId: "write-denied",
    code: "permission_denied",
    message: "Path /docs/private/state.json is outside the token path globs: /docs/allowed/**",
  });
  assert.equal(writes.length, 0);
});

test("gateway reads raw Slack channel event paths through same-channel mounted aliases", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const readPaths: string[] = [];
  gateway["resolveRelayfileSession"] = async () =>
    ({
      workspace: "support",
      pathGlobs: ["/slack/channels/C123__pear-pty-investigation/messages/**"],
      client: {
        async readFile(_workspace: string, path: string) {
          readPaths.push(path);
          if (path === "/slack/channels/C123/messages/1710000000_000001/meta.json") {
            throw new RelayFileApiError(404, {
              code: "not_found",
              message: "file not found",
            });
          }

          assert.equal(
            path,
            "/slack/channels/C123__pear-pty-investigation/messages/1710000000_000001/meta.json",
          );
          return {
            path,
            revision: "rev-slack-1",
            contentType: "application/json",
            content: "{\"text\":\"hello\"}",
            encoding: "utf-8",
          };
        },
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "files_read",
    requestId: "read-slack",
    path: "/slack/channels/C123/messages/1710000000_000001/meta.json",
  }));

  assert.deepEqual(await waitForMessage(messages, 0), {
    type: "files_read_result",
    requestId: "read-slack",
    file: {
      path: "/slack/channels/C123__pear-pty-investigation/messages/1710000000_000001/meta.json",
      revision: "rev-slack-1",
      contentType: "application/json",
      content: "{\"text\":\"hello\"}",
      encoding: "utf-8",
    },
  });
  assert.deepEqual(readPaths, [
    "/slack/channels/C123/messages/1710000000_000001/meta.json",
    "/slack/channels/C123__pear-pty-investigation/messages/1710000000_000001/meta.json",
  ]);
});

test("gateway does not treat Slack DM paths as selected channel aliases", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  let readCount = 0;
  gateway["resolveRelayfileSession"] = async () =>
    ({
      workspace: "support",
      pathGlobs: ["/slack/channels/C123__pear-pty-investigation/messages/**"],
      client: {
        async readFile() {
          readCount += 1;
          throw new Error("should not read outside selected channel scope");
        },
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "files_read",
    requestId: "read-dm",
    path: "/slack/dms/D123/messages/1710000000_000001/meta.json",
  }));

  assert.deepEqual(await waitForMessage(messages, 0), {
    type: "files_error",
    requestId: "read-dm",
    code: "permission_denied",
    message:
      "Path /slack/dms/D123/messages/1710000000_000001/meta.json is outside the token path globs: /slack/channels/C123__pear-pty-investigation/messages/**",
  });
  assert.equal(readCount, 0);
});

test("gateway proxies ctx.messages RPCs through the websocket control channel", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const calls: string[] = [];
  gateway["postRelaycastChannelMessage"] = async (
    _agentId: string,
    channel: string,
    text: string,
  ) => {
    calls.push(`post:${channel}:${text}`);
    return { id: "msg-1" };
  };
  gateway["replyRelaycastMessage"] = async (
    _agentId: string,
    threadId: string,
    text: string,
  ) => {
    calls.push(`reply:${threadId}:${text}`);
    return { id: "msg-2" };
  };
  gateway["sendRelaycastDm"] = async (
    _agentId: string,
    agentOrUser: string,
    text: string,
  ) => {
    calls.push(`dm:${agentOrUser}:${text}`);
    return { id: "msg-3" };
  };

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relay-omni-token",
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "messages_post",
    requestId: "post-1",
    channel: "ops",
    text: "hello",
  }));
  assert.deepEqual(await waitForMessage(messages, 0), {
    type: "messages_result",
    requestId: "post-1",
    id: "msg-1",
  });

  client.send(JSON.stringify({
    type: "messages_reply",
    requestId: "reply-1",
    threadId: "thread-1",
    text: "ack",
  }));
  assert.deepEqual(await waitForMessage(messages, 1), {
    type: "messages_result",
    requestId: "reply-1",
    id: "msg-2",
  });

  client.send(JSON.stringify({
    type: "messages_dm",
    requestId: "dm-1",
    agentOrUser: "teammate",
    text: "ping",
  }));
  assert.deepEqual(await waitForMessage(messages, 2), {
    type: "messages_result",
    requestId: "dm-1",
    id: "msg-3",
  });

  assert.deepEqual(calls, [
    "post:ops:hello",
    "reply:thread-1:ack",
    "dm:teammate:ping",
  ]);
});

test("gateway resolves pending approval waits when approval files arrive", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  gateway["tryResolveApproval"] = async () => undefined;
  gateway["getRelayfileClient"] = () =>
    ({
      async readFile(_workspace: string, path: string) {
        assert.equal(path, "/approvals/approval-1.json");
        return {
          path,
          contentType: "application/json",
          content: "{\"verdict\":\"approved\",\"approvedBy\":\"human\"}",
        };
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relay-omni-token",
  });

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "approval_wait",
    requestId: "approval-wait-1",
    approvalId: "approval-1",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);

  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-approval-1",
    type: "updated",
    path: "/approvals/approval-1.json",
    revision: "rev-approval-1",
    timestamp: "2026-05-12T00:00:00.000Z",
    provider: "relayfile",
  });

  assert.deepEqual(await waitForMessage(messages, 0), {
    type: "approval_result",
    requestId: "approval-wait-1",
    approval: {
      verdict: "approved",
      approvedBy: "human",
    },
  });
});

test("gateway persists structured SDK logs to relayfile jsonl files", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const writes: Array<Record<string, unknown>> = [];
  gateway["resolveRelayfileSession"] = async () =>
    ({
      workspace: "support",
      client: {
        async readFile() {
          throw new RelayFileApiError(404, {
            code: "not_found",
            message: "missing",
          });
        },
        async writeFile(input: Record<string, unknown>) {
          writes.push(input);
          return {
            opId: "op-log-1",
            status: "queued",
            targetRevision: "rev-log-1",
          };
        },
      },
    }) as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const { client, server } = createLinkedSockets();
  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  client.send(JSON.stringify({
    type: "log",
    entry: {
      ts: "2026-05-12T12:34:56.000Z",
      level: "info",
      workspace: "spoofed",
      agentId: "spoofed-agent",
      eventId: "evt-log-1",
      msg: "processed",
      phase: "handler",
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    workspaceId: "support",
    path: "/_logs/support/2026-05-12.jsonl",
    baseRevision: "*",
    content: `${JSON.stringify({
      ts: "2026-05-12T12:34:56.000Z",
      level: "info",
      workspace: "support",
      agentId: "support-agent",
      eventId: "evt-log-1",
      msg: "processed",
      phase: "handler",
    })}\n`,
    contentType: "application/x-ndjson",
    encoding: "utf-8",
  });
});

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  index: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (messages[index]) {
      return messages[index];
    }
  }

  throw new Error(`Timed out waiting for gateway message ${index}`);
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}
