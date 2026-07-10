import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createContextFactory } from "@agent-relay/agent";

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function withoutVitestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitizedEnv)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete sanitizedEnv[key];
    }
  }
  sanitizedEnv.NO_COLOR = "1";
  sanitizedEnv.FORCE_COLOR = "0";
  return sanitizedEnv;
}

test("M3 inbox/policy E2E wrapper: suggest mode returns a proposal without sending", async () => {
  const calls: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async () => {},
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async () => {
      calls.push("post");
      return { id: "msg-1" };
    },
    reply: async () => ({ id: "msg-2" }),
    dm: async () => ({ id: "msg-3" }),
  };
  const { base } = createContextFactory({
    workspace: "support",
    agentId: "support-agent",
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    policy: {
      mode: "suggest",
    },
    trackSchedule() {},
  });

  const result = await base.messages.post("#support-agents", "hello from suggest mode");
  if (!result || !("decision" in result)) {
    assert.fail("Expected policy suggestion result in suggest mode");
  }

  assert.equal(result.decision, "suggested");
  assert.equal(result.actionType, "external-message");
  assert.equal(result.workspace, "support");
  assert.equal(result.agentId, "support-agent");
  assert.equal(result.action?.method, "post");
  assert.equal(result.action?.channel, "#support-agents");
  assert.equal(result.action?.text, "hello from suggest mode");
  assert.equal(calls.includes("post"), false);
  assert.equal(
    calls.filter((entry) => entry.startsWith("write:/_policy-log/support/")).length,
    1,
  );
});

test("M3 inbox/policy E2E wrapper: approval-gated messages write pending approvals and resume on approval", async () => {
  const calls: string[] = [];
  const approvals: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async () => {},
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async (channel: string, text: string) => {
      calls.push(`post:${channel}:${text}`);
      return { id: "msg-1" };
    },
    reply: async () => ({ id: "msg-2" }),
    dm: async () => ({ id: "msg-3" }),
  };
  const { base } = createContextFactory({
    workspace: "support",
    agentId: "support-agent",
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    awaitApproval: async (approvalId) => {
      approvals.push(approvalId);
      return {
        verdict: "approved",
        sourcePath: `/approvals/${approvalId}.json`,
      };
    },
    policy: {
      mode: "auto",
      approvals: ["external-message"],
    },
    trackSchedule() {},
  });

  const result = await base.messages.post("#support-agents", "needs approval");

  assert.deepEqual(result, { id: "msg-1" });
  assert.equal(approvals.length, 1);
  assert.ok(calls.some((entry) => entry.startsWith("write:/pending-approvals/")));
  assert.ok(calls.some((entry) => entry.startsWith("write:/_policy-log/support/")));
  assert.ok(calls.includes("post:#support-agents:needs approval"));
});

test("M3 inbox/policy E2E wrapper: runs the real gateway inbox fan-in suites", async () => {
  const vitestEntrypoint = fileURLToPath(
    new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  const gateway = await execFileAsync(
    process.execPath,
    [
      vitestEntrypoint,
      "run",
      "--config",
      "services/agent-gateway/vitest.config.ts",
      "services/agent-gateway/tests/files-rpc.test.ts",
      "services/agent-gateway/tests/envelope-builder.test.ts",
      "services/agent-gateway/tests/inbox-subscriber.test.ts",
      "services/agent-gateway/tests/inbox.test.ts",
    ],
    {
      cwd: repoRoot,
      env: withoutVitestEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const web = await execFileAsync(
    process.execPath,
    [
      vitestEntrypoint,
      "run",
      "--config",
      "vitest.config.ts",
      "packages/web/lib/proactive-runtime/inbox-selectors.test.ts",
      "packages/web/app/api/internal/proactive-runtime/inbox/route.test.ts",
    ],
    {
      cwd: repoRoot,
      env: withoutVitestEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const gatewayOutput = stripAnsi(`${gateway.stdout}\n${gateway.stderr}`);
  const webOutput = stripAnsi(`${web.stdout}\n${web.stderr}`);
  assert.match(gatewayOutput, /Test Files\s+4 passed \(4\)/);
  assert.match(webOutput, /Test Files\s+2 passed \(2\)/);
});
