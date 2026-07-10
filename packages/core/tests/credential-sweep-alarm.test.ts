import assert from "node:assert/strict";
import test from "node:test";

import { logExhaustedCredentialAlarm } from "../src/auth/credential-sweep.js";

/**
 * The exhausted-credential census is the alarm half of the sweep: exhausted
 * rows leave the refresh SELECT forever (`refresh_exhausted = FALSE`
 * filter), so the census line repeating EVERY sweep is the only continuous
 * signal that a credential is dead (2026-06-04 pr-reviewer outage class).
 * These tests pin: silence when healthy, one structured console.error line
 * with actionable fields when not.
 */

function fakeClient(rows: Array<Record<string, unknown>>, total = rows.length) {
  const queries: string[] = [];
  return {
    queries,
    query: (async (sql: string) => {
      queries.push(sql);
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: String(total) }] };
      }
      return { rows };
    }) as never,
  };
}

test("stays silent when no credential is refresh-exhausted", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });

  const client = fakeClient([]);
  const count = await logExhaustedCredentialAlarm(client);

  assert.equal(count, 0);
  assert.equal(errors.length, 0, "healthy sweeps must not emit the alarm line");
  assert.match(client.queries[0]!, /COUNT\(\*\)/);
  assert.match(client.queries[0]!, /refresh_exhausted = TRUE/);
  assert.equal(client.queries.length, 1, "zero exhausted rows must skip the sample query");
});

test("emits one structured ALARM line naming every exhausted credential", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });

  const count = await logExhaustedCredentialAlarm(
    fakeClient([
      {
        id: "cred-1",
        user_id: "user-1",
        workspace_id: "ws-1",
        model_provider: "openai",
        harness: "codex",
        auth_type: "provider_oauth",
        last_error: "invalid_grant",
        credential_expires_at: "2026-06-04T05:00:00.000Z",
        last_refresh_attempt_at: "2026-06-04T05:10:00.000Z",
      },
      {
        id: "cred-2",
        user_id: "user-2",
        workspace_id: "ws-1",
        model_provider: "anthropic",
        harness: "claude",
        auth_type: "provider_oauth",
        last_error: "token revoked",
        credential_expires_at: null,
        last_refresh_attempt_at: null,
      },
    ]),
  );

  assert.equal(count, 2);
  assert.equal(errors.length, 1, "exactly one alarm line per sweep");

  const [message, payloadJson] = errors[0]!;
  assert.match(String(message), /credential sweep ALARM/);
  const payload = JSON.parse(String(payloadJson)) as {
    count: number;
    sampleTruncated: boolean;
    credentials: Array<Record<string, unknown>>;
  };
  assert.equal(payload.count, 2);
  assert.equal(payload.sampleTruncated, false);
  // Actionable without a DB query: who, which provider/harness, why, since when.
  assert.deepEqual(payload.credentials[0], {
    id: "cred-1",
    userId: "user-1",
    workspaceId: "ws-1",
    provider: "openai",
    harness: "codex",
    authType: "provider_oauth",
    lastError: "invalid_grant",
    exhaustedSinceApprox: "2026-06-04T05:10:00.000Z",
    expiresAt: "2026-06-04T05:00:00.000Z",
  });
  // No secrets: the payload must never carry tokens or credential JSON.
  assert.ok(!String(payloadJson).match(/token"|access|refresh_token|Bearer/i));
});

test("reports the true total with a truncated-sample flag under mass exhaustion", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });

  const count = await logExhaustedCredentialAlarm(
    fakeClient(
      [
        {
          id: "cred-1",
          user_id: "user-1",
          workspace_id: "ws-1",
          model_provider: "openai",
          harness: "codex",
          auth_type: "provider_oauth",
          last_error: "invalid_grant",
          credential_expires_at: null,
          last_refresh_attempt_at: null,
        },
      ],
      137, // true total far above the 50-row sample cap
    ),
  );

  assert.equal(count, 137, "count must be the true COUNT(*), not the sample size");
  const payload = JSON.parse(String(errors[0]![1])) as {
    count: number;
    sampleTruncated: boolean;
  };
  assert.equal(payload.count, 137);
  assert.equal(payload.sampleTruncated, true);
});
