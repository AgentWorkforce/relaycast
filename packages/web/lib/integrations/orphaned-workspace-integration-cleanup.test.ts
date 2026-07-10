import { describe, expect, it, vi } from "vitest";
import {
  createRelayfileSubtreeFingerprint,
  removeOrphanedWorkspaceIntegration,
  type OrphanedWorkspaceIntegrationCandidate,
  type RelayfileFingerprintClient,
} from "./orphaned-workspace-integration-cleanup";

function candidate(
  overrides: Partial<OrphanedWorkspaceIntegrationCandidate> = {},
): OrphanedWorkspaceIntegrationCandidate {
  return {
    id: "integration-1",
    workspaceId: "rw_12345678",
    provider: "google-mail",
    name: null,
    connectionId: "conn_google_mail_orphan",
    providerConfigKey: "google-mail-relay",
    installationId: null,
    createdAt: new Date("2026-05-28T08:00:00.000Z"),
    updatedAt: new Date("2026-05-28T08:00:00.000Z"),
    ...overrides,
  };
}

describe("removeOrphanedWorkspaceIntegration", () => {
  const connectionId = "conn_google_mail_orphan";

  it("dry-runs by default and does not delete the matched row", async () => {
    const deleteCandidate = vi.fn(async () => true);

    const result = await removeOrphanedWorkspaceIntegration(
      { connectionId },
      {
        listCandidates: async () => [candidate()],
        deleteCandidate,
      },
    );

    expect(deleteCandidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      matched: 1,
      deleted: 0,
      status: "would_delete",
      provider: "google-mail",
      connectionId: "conn_google_mail_orphan",
    });
  });

  it("deletes only after the exact orphan row is selected", async () => {
    const row = candidate();
    const deleteCandidate = vi.fn(async () => true);

    const result = await removeOrphanedWorkspaceIntegration(
      { dryRun: false, connectionId },
      {
        listCandidates: async () => [row],
        deleteCandidate,
      },
    );

    expect(deleteCandidate).toHaveBeenCalledWith(row);
    expect(result).toMatchObject({
      dryRun: false,
      matched: 1,
      deleted: 1,
      status: "deleted",
    });
  });

  it("blocks if more than one row matches", async () => {
    const deleteCandidate = vi.fn(async () => true);

    const result = await removeOrphanedWorkspaceIntegration(
      { dryRun: false, connectionId },
      {
        listCandidates: async () => [
          candidate({ id: "integration-1", workspaceId: "rw_11111111" }),
          candidate({ id: "integration-2", workspaceId: "rw_22222222" }),
        ],
        deleteCandidate,
      },
    );

    expect(deleteCandidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      matched: 2,
      deleted: 0,
      status: "blocked_multiple_matches",
    });
  });

  it("verifies RelayFile before and after apply", async () => {
    const fingerprintRelayfile = vi.fn(async (workspaceId: string) => ({
      workspaceId,
      root: "/google-mail",
      fileCount: 1,
      totalBytes: 13,
      digest: "same-digest",
      sampledFiles: [],
    }));

    const result = await removeOrphanedWorkspaceIntegration(
      { dryRun: false, verifyRelayfile: true, connectionId },
      {
        listCandidates: async () => [candidate()],
        deleteCandidate: async () => true,
        fingerprintRelayfile,
      },
    );

    expect(fingerprintRelayfile).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "deleted",
      beforeRelayfile: { digest: "same-digest" },
      afterRelayfile: { digest: "same-digest" },
    });
  });

  it("reports a failed verification if /google-mail changes during cleanup", async () => {
    const fingerprintRelayfile = vi
      .fn()
      .mockResolvedValueOnce({
        workspaceId: "rw_12345678",
        root: "/google-mail",
        fileCount: 1,
        totalBytes: 13,
        digest: "before",
        sampledFiles: [],
      })
      .mockResolvedValueOnce({
        workspaceId: "rw_12345678",
        root: "/google-mail",
        fileCount: 1,
        totalBytes: 13,
        digest: "after",
        sampledFiles: [],
      });

    const result = await removeOrphanedWorkspaceIntegration(
      { dryRun: false, verifyRelayfile: true, connectionId },
      {
        listCandidates: async () => [candidate()],
        deleteCandidate: async () => true,
        fingerprintRelayfile,
      },
    );

    expect(result).toMatchObject({
      matched: 1,
      deleted: 1,
      status: "relayfile_changed",
    });
  });

  it("requires an explicit connection id", async () => {
    await expect(removeOrphanedWorkspaceIntegration()).rejects.toThrow(
      "connectionId is required",
    );
  });
});

describe("createRelayfileSubtreeFingerprint", () => {
  it("hashes sorted file contents under the provider root", async () => {
    const client: RelayfileFingerprintClient = {
      listTree: vi.fn(async () => ({
        nextCursor: null,
        entries: [
          { path: "/google-mail/messages/b.json", type: "file" as const, revision: "2" },
          { path: "/google-mail/messages", type: "dir" as const, revision: "dir" },
          { path: "/google-mail/messages/a.json", type: "file" as const, revision: "1" },
        ],
      })),
      readFile: vi.fn(async (_workspaceId, path) => ({
        path,
        revision: path.endsWith("a.json") ? "1" : "2",
        contentType: "application/json",
        content: path.endsWith("a.json") ? "{\"id\":\"a\"}" : "{\"id\":\"b\"}",
        encoding: "utf-8" as const,
      })),
    };

    const fingerprint = await createRelayfileSubtreeFingerprint(
      client,
      "rw_12345678",
      { sampleLimit: 1 },
    );

    expect(client.listTree).toHaveBeenCalledWith(
      "rw_12345678",
      expect.objectContaining({ path: "/google-mail", depth: 20 }),
    );
    expect(client.readFile).toHaveBeenNthCalledWith(
      1,
      "rw_12345678",
      "/google-mail/messages/a.json",
      "cloud-1311-google-mail-cleanup",
      undefined,
    );
    expect(fingerprint).toMatchObject({
      workspaceId: "rw_12345678",
      root: "/google-mail",
      fileCount: 2,
      totalBytes: 20,
    });
    expect(fingerprint.sampledFiles).toHaveLength(1);
    expect(fingerprint.sampledFiles[0]?.path).toBe(
      "/google-mail/messages/a.json",
    );
    expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads files with bounded concurrency", async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const releaseRead: Array<() => void> = [];
    const client: RelayfileFingerprintClient = {
      listTree: vi.fn(async () => ({
        nextCursor: null,
        entries: [
          { path: "/google-mail/messages/1.json", type: "file" as const, revision: "1" },
          { path: "/google-mail/messages/2.json", type: "file" as const, revision: "2" },
          { path: "/google-mail/messages/3.json", type: "file" as const, revision: "3" },
        ],
      })),
      readFile: vi.fn(async (_workspaceId, path) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise<void>((resolve) => {
          releaseRead.push(resolve);
          queueMicrotask(resolve);
        });
        activeReads -= 1;
        return {
          path,
          revision: path.match(/(\d+)\.json$/)?.[1] ?? "0",
          contentType: "application/json",
          content: "{}",
          encoding: "utf-8" as const,
        };
      }),
    };

    await createRelayfileSubtreeFingerprint(client, "rw_12345678", {
      readConcurrency: 2,
    });

    expect(client.readFile).toHaveBeenCalledTimes(3);
    expect(maxActiveReads).toBe(2);
    expect(releaseRead).toHaveLength(3);
  });
});
