import { describe, expect, it, vi } from "vitest";
import {
  backfillProviderCredentialAccountEmails,
  type ProviderCredentialAccountEmailCandidate,
} from "./provider-credential-account-email-backfill";

const baseCandidate: ProviderCredentialAccountEmailCandidate = {
  id: "00000000-0000-0000-0000-000000000001",
  organizationId: "00000000-0000-0000-0000-000000000010",
  workspaceId: "00000000-0000-0000-0000-000000000020",
  userId: "00000000-0000-0000-0000-000000000030",
  harness: "claude",
  modelProvider: "anthropic",
  authType: "provider_oauth",
  accountEmail: null,
};

function candidate(
  overrides: Partial<ProviderCredentialAccountEmailCandidate> = {},
): ProviderCredentialAccountEmailCandidate {
  return { ...baseCandidate, ...overrides };
}

describe("backfillProviderCredentialAccountEmails", () => {
  it("dry-runs provider OAuth rows using the provider-name store key", async () => {
    const row = candidate({ modelProvider: "claude" });
    const retrieveCredential = vi.fn().mockResolvedValue(JSON.stringify({
      claudeAiOauth: { email: "claude@example.com" },
    }));
    const updateAccountEmail = vi.fn();

    const summary = await backfillProviderCredentialAccountEmails(
      { dryRun: true },
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
        updateAccountEmail,
      },
    );

    expect(retrieveCredential).toHaveBeenCalledWith(row, "anthropic");
    expect(updateAccountEmail).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      dryRun: true,
      scanned: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
      results: [{
        id: row.id,
        credentialStoreKey: "anthropic",
        accountEmail: "claude@example.com",
        status: "would_update",
      }],
    });
  });

  it("updates parsed account emails in apply mode", async () => {
    const row = candidate();
    const updateAccountEmail = vi.fn().mockResolvedValue(true);

    const summary = await backfillProviderCredentialAccountEmails(
      { dryRun: false },
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential: vi.fn().mockResolvedValue(JSON.stringify({
          account: { emailAddress: "active@example.com" },
        })),
        updateAccountEmail,
      },
    );

    expect(updateAccountEmail).toHaveBeenCalledWith(row, "active@example.com");
    expect(summary.updated).toBe(1);
    expect(summary.results[0]).toMatchObject({
      accountEmail: "active@example.com",
      status: "updated",
    });
  });

  it("retrieves BYOK rows by credential id and skips blobs without an email", async () => {
    const row = candidate({
      id: "00000000-0000-0000-0000-000000000099",
      authType: "byo_api_key",
      modelProvider: "openai",
      harness: "codex",
    });
    const retrieveCredential = vi.fn().mockResolvedValue(JSON.stringify({
      type: "api_key",
      modelProvider: "openai",
      key: "sk-test",
    }));

    const summary = await backfillProviderCredentialAccountEmails(
      {},
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
        updateAccountEmail: vi.fn(),
      },
    );

    expect(retrieveCredential).toHaveBeenCalledWith(row, row.id);
    expect(summary).toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      results: [{
        credentialStoreKey: row.id,
        status: "skipped_no_email",
      }],
    });
  });

  it("retrieves setup-token rows by normalized provider key", async () => {
    const row = candidate({
      authType: "oauth_token",
      modelProvider: "claude",
    });
    const retrieveCredential = vi.fn().mockResolvedValue(JSON.stringify({
      accountEmail: "setup@example.com",
    }));

    const summary = await backfillProviderCredentialAccountEmails(
      { dryRun: true },
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
        updateAccountEmail: vi.fn(),
      },
    );

    expect(retrieveCredential).toHaveBeenCalledWith(row, "anthropic");
    expect(summary.results[0]).toMatchObject({
      credentialStoreKey: "anthropic",
      accountEmail: "setup@example.com",
      status: "would_update",
    });
  });

  it("skips relay-managed rows because they have no credential-store blob", async () => {
    const row = candidate({ authType: "relay_managed" });
    const retrieveCredential = vi.fn();

    const summary = await backfillProviderCredentialAccountEmails(
      {},
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
      },
    );

    expect(retrieveCredential).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      credentialStoreKey: null,
      status: "skipped_no_store",
    });
  });

  it("skips unsupported auth types without guessing a store key", async () => {
    const row = candidate({ authType: "future_auth_type" });
    const retrieveCredential = vi.fn();

    const summary = await backfillProviderCredentialAccountEmails(
      {},
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
      },
    );

    expect(retrieveCredential).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      credentialStoreKey: null,
      status: "skipped_unsupported_auth_type",
    });
  });

  it("passes valid options through to the candidate lister", async () => {
    const listCandidates = vi.fn().mockResolvedValue([]);

    await backfillProviderCredentialAccountEmails(
      {
        dryRun: true,
        workspaceId: "workspace-1",
        userId: "user-1",
        provider: "claude",
        authType: "oauth_token",
        limit: 10,
      },
      { listCandidates },
    );

    expect(listCandidates).toHaveBeenCalledWith({
      dryRun: true,
      workspaceId: "workspace-1",
      userId: "user-1",
      provider: "claude",
      authType: "oauth_token",
      limit: 10,
    });
  });

  it("rejects invalid limits before listing candidates", async () => {
    const listCandidates = vi.fn();

    await expect(backfillProviderCredentialAccountEmails(
      { limit: 0 },
      { listCandidates },
    )).rejects.toThrow("limit must be a positive integer");
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it("stays idempotent when a row already has account_email", async () => {
    const row = candidate({ accountEmail: "existing@example.com" });
    const retrieveCredential = vi.fn();

    const summary = await backfillProviderCredentialAccountEmails(
      {},
      {
        listCandidates: vi.fn().mockResolvedValue([row]),
        retrieveCredential,
      },
    );

    expect(retrieveCredential).not.toHaveBeenCalled();
    expect(summary.results[0]).toMatchObject({
      accountEmail: "existing@example.com",
      status: "skipped_already_has_email",
    });
  });

  it("records missing blobs and per-row failures without stopping the backfill", async () => {
    const missing = candidate({ id: "missing" });
    const failing = candidate({ id: "failing" });
    const good = candidate({ id: "good" });
    const retrieveCredential = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("decrypt failed"))
      .mockResolvedValueOnce(JSON.stringify({ email: "good@example.com" }));

    const summary = await backfillProviderCredentialAccountEmails(
      {},
      {
        listCandidates: vi.fn().mockResolvedValue([missing, failing, good]),
        retrieveCredential,
        updateAccountEmail: vi.fn(),
      },
    );

    expect(summary).toMatchObject({
      scanned: 3,
      updated: 1,
      skipped: 1,
      failed: 1,
    });
    expect(summary.results.map((result) => result.status)).toEqual([
      "skipped_missing_credential",
      "failed",
      "would_update",
    ]);
    expect(summary.results[1].error).toBe("decrypt failed");
  });
});
