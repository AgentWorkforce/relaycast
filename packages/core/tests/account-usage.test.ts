import test from "node:test";
import assert from "node:assert/strict";

import {
  claudeUsageSnapshotFromResponse,
  codexUsageSnapshotFromResponse,
  extractClaudeUsageCredential,
  extractCodexUsageCredential,
  fetchAccountUsageSnapshot,
} from "../src/auth/account-usage.ts";

const now = new Date("2026-06-12T10:00:00.000Z");

test("maps Codex OAuth usage windows and credits", () => {
  const snapshot = codexUsageSnapshotFromResponse(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 64.2,
          reset_at: 1781262000,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 35,
          reset_at: 1781662000,
          limit_window_seconds: 604800,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3 Codex Spark",
          rate_limit: {
            primary_window: {
              used_percent: 80,
              reset_at: 1781263000,
              limit_window_seconds: 18000,
            },
          },
        },
      ],
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
    },
    { idToken: null },
    now,
  );

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.plan, "pro");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0].remainingPercent, 35.8);
  assert.equal(snapshot.windows[0].windowMinutes, 300);
  assert.equal(snapshot.credits?.balance, 12.5);
});

test("maps Claude OAuth usage windows", () => {
  const snapshot = claudeUsageSnapshotFromResponse(
    {
      five_hour: { utilization: 22, resets_at: "2026-06-12T15:00:00.000Z" },
      seven_day: { utilization: 70, resets_at: "2026-06-15T00:00:00Z" },
      seven_day_sonnet: { utilization: 44 },
      extra_usage: { monthly_limit: 1000, used_credits: 275 },
    },
    now,
  );

  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.windows.length, 3);
  assert.equal(snapshot.windows[0].label, "Session");
  assert.equal(snapshot.windows[1].remainingPercent, 30);
  assert.equal(snapshot.credits?.balance, 725);
});

test("extracts stored Codex and Claude credential tokens", () => {
  assert.deepEqual(
    extractCodexUsageCredential(JSON.stringify({
      tokens: {
        access_token: "codex-access",
        refresh_token: "refresh",
        id_token: "id",
        account_id: "acct_123",
      },
    })),
    { accessToken: "codex-access", accountId: "acct_123", idToken: "id" },
  );

  assert.deepEqual(
    extractCodexUsageCredential(JSON.stringify({
      account_id: "acct_top_level",
      tokens: {
        access_token: "codex-access",
        refresh_token: "refresh",
      },
    })),
    { accessToken: "codex-access", accountId: "acct_top_level", idToken: null },
  );

  assert.deepEqual(
    extractClaudeUsageCredential(JSON.stringify({
      claudeAiOauth: { accessToken: "claude-access" },
    })),
    { accessToken: "claude-access" },
  );

  assert.deepEqual(
    extractClaudeUsageCredential(JSON.stringify({
      type: "oauth_token",
      token: "setup-token",
    })),
    { accessToken: "setup-token" },
  );
});

test("fetchAccountUsageSnapshot uses provider endpoints and auth headers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_at: 1781262000,
          limit_window_seconds: 18000,
        },
      },
    }));
  };

  const snapshot = await fetchAccountUsageSnapshot({
    provider: "openai",
    credentialJson: JSON.stringify({
      tokens: { access_token: "codex-access", account_id: "acct_123" },
    }),
    fetch: fakeFetch,
    now,
  });

  assert.equal(snapshot.status, "available");
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer codex-access");
  assert.equal(headers.get("chatgpt-account-id"), "acct_123");
  assert.equal(headers.get("user-agent"), "CodexBar");
});

test("fetchAccountUsageSnapshot does not call Codex usage without account id", async () => {
  let called = false;
  const snapshot = await fetchAccountUsageSnapshot({
    provider: "openai",
    credentialJson: JSON.stringify({
      tokens: { access_token: "codex-access" },
    }),
    fetch: async () => {
      called = true;
      return new Response("{}");
    },
    now,
  });

  assert.equal(called, false);
  assert.equal(snapshot.status, "unavailable");
  assert.match(snapshot.error ?? "", /account id/);
});

test("fetchAccountUsageSnapshot suppresses HTML error bodies", async () => {
  const snapshot = await fetchAccountUsageSnapshot({
    provider: "openai",
    credentialJson: JSON.stringify({
      tokens: { access_token: "codex-access", account_id: "acct_123" },
    }),
    fetch: async () => new Response("<!DOCTYPE html><html><body>blocked</body></html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    }),
    now,
  });

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "HTTP 403");
});
