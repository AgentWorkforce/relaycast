import { describe, expect, it, vi } from "vitest";
import { computeGitHubPath } from "@relayfile/adapter-github/path-mapper";

import {
  sanitizeJiraRecordForStorage,
  writeBatchToRelayfile,
  writeProviderRecord,
  type RelayfileWriteClient,
} from "../packages/core/src/sync/record-writer.js";
import type { NangoSyncJob } from "../packages/core/src/sync/nango-sync-job.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function createClient(overrides?: Partial<RelayfileWriteClient>): RelayfileWriteClient {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * The provider contract surface (root + provider LAYOUT.md and the
 * `discovery/<provider>/...` schema/example/adapter docs) is materialized on
 * EVERY sync batch, idempotently — that is the fix for the rw_fc7b534b
 * "discovery entirely absent" defect. These stale-skip tests assert
 * *record-level* behavior, so assert no non-contract write/delete happened
 * rather than no client call at all.
 */
function isContractPath(path: unknown): boolean {
  return (
    typeof path === "string" &&
    (path === "/LAYOUT.md" ||
      path.endsWith("/LAYOUT.md") ||
      path.startsWith("/discovery/"))
  );
}

function expectNoRecordMutations(client: RelayfileWriteClient): void {
  const writeCalls = (client.writeFile as ReturnType<typeof vi.fn>).mock.calls;
  const deleteCalls = (client.deleteFile as ReturnType<typeof vi.fn>).mock
    .calls;
  for (const [arg] of writeCalls) {
    const path = (arg as { path?: unknown })?.path;
    expect(isContractPath(path), `unexpected record write to ${path}`).toBe(
      true,
    );
  }
  for (const [arg] of deleteCalls) {
    const path = (arg as { path?: unknown })?.path;
    expect(isContractPath(path), `unexpected record delete of ${path}`).toBe(
      true,
    );
  }
}

function createJob(overrides: Partial<NangoSyncJob> = {}): NangoSyncJob {
  return {
    type: "nango_sync",
    provider: "github",
    connectionId: "conn-123",
    providerConfigKey: "github-sage",
    syncName: "fetch-repos",
    model: "Repo",
    modifiedAfter: "2026-01-01T00:00:00Z",
    cursor: null,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function objectContainsValue(value: unknown, needle: unknown): boolean {
  if (value === needle) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => objectContainsValue(item, needle));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => objectContainsValue(item, needle));
  }
  return false;
}

describe("writeProviderRecord", () => {
  it("writes GitHub repository records to the adapter-computed metadata path", async () => {
    const client = createClient();

    const result = await writeProviderRecord(
      client,
      {
        id: "repo-1",
        full_name: "AgentWorkforce/cloud",
        description: "Cloud app",
        _nango_metadata: { last_action: "ADDED" },
      },
      createJob(),
    );

    expect(result).toBe("written");
    expect(client.writeFile).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      path: "/github/repos/AgentWorkforce/cloud/metadata.json",
      content: JSON.stringify({
        id: "repo-1",
        full_name: "AgentWorkforce/cloud",
        description: "Cloud app",
      }),
      contentType: "application/json; charset=utf-8",
      encoding: "utf-8",
      baseRevision: "*",
    });
  });

  it("deletes GitHub issue records marked deleted by Nango metadata", async () => {
    const client = createClient({
      readFile: vi.fn().mockResolvedValue({ content: "{}", revision: "rev_7" }),
    });
    const expectedPath = computeGitHubPath("issue", "7", {
      owner: "AgentWorkforce",
      repo: "cloud",
    });

    const result = await writeProviderRecord(
      client,
      {
        id: "issue-7",
        number: 7,
        full_name: "AgentWorkforce/cloud",
        _nango_metadata: { last_action: "DELETED" },
      },
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toBe("deleted");
    expect(client.deleteFile).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      path: expectedPath,
      baseRevision: "rev_7",
    });
    expect(client.writeFile).not.toHaveBeenCalled();
  });

  it("uses the current Relayfile revision when deleting provider tombstones", async () => {
    const client = createClient({
      readFile: vi.fn().mockResolvedValue({ content: "{}", revision: "rev_42" }),
    });
    const expectedPath = computeGitHubPath("issue", "8", {
      owner: "AgentWorkforce",
      repo: "cloud",
    });

    const result = await writeProviderRecord(
      client,
      {
        id: "issue-8",
        number: 8,
        full_name: "AgentWorkforce/cloud",
        _nango_metadata: { last_action: "DELETED" },
      },
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toBe("deleted");
    expect(client.deleteFile).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      path: expectedPath,
      baseRevision: "rev_42",
    });
  });

  it("skips provider tombstone deletes when the current Relayfile file cannot be read", async () => {
    const client = createClient({
      readFile: vi.fn().mockRejectedValue({ status: 404 }),
    });

    const result = await writeProviderRecord(
      client,
      {
        id: "issue-404",
        number: 404,
        full_name: "AgentWorkforce/cloud",
        _nango_metadata: { last_action: "DELETED" },
      },
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toBe("deleted");
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it("writes Linear records using normalized model names", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "LIN-123",
        identifier: "ENG-123",
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        model: "LinearIssue",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        path: "/linear/issues/ENG-123__LIN-123.json",
      }),
    );
  });

  it("writes newer Linear sync models to canonical object directories", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "roadmap-1",
        name: "Platform roadmap",
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        syncName: "fetch-roadmaps",
        model: "LinearRoadmap",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        path: "/linear/roadmaps/roadmap-1.json",
        semantics: expect.objectContaining({
          properties: expect.objectContaining({
            "linear.object_type": "roadmap",
            "linear.name": "Platform roadmap",
          }),
        }),
      }),
    );
  });

  it("routes Slack thread replies beneath the parent thread", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "reply-1",
        channel: "C024BE91L",
        thread_ts: "1712345678.000100",
        ts: "1712345680.000200",
        text: "reply",
        _nango_metadata: { last_action: "ADDED" },
      },
      createJob({
        provider: "slack",
        providerConfigKey: "slack-relay",
        model: "SlackMessage",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        path: "/slack/channels/C024BE91L/threads/1712345678_000100/replies/1712345680_000200/meta.json",
      }),
    );
  });

  it("writes Jira records without storing Atlassian user profile data", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "10001",
        key: "ENG-42",
        fields: {
          summary: "Fix login redirect",
          assignee: {
            accountId: "acct-1",
            displayName: "Ada Lovelace",
            emailAddress: "ada@example.com",
            timeZone: "Europe/London",
            avatarUrls: { "48x48": "https://avatar.example/ada.png" },
          },
          reporter: {
            accountId: "acct-2",
            displayName: "Grace Hopper",
            emailAddress: "grace@example.com",
          },
          status: { name: "In Progress" },
          project: { key: "ENG" },
        },
        changelog: {
          histories: [{ author: { accountId: "acct-1", displayName: "Ada Lovelace" } }],
        },
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "jira",
        providerConfigKey: "jira-relay",
        syncName: "fetch-issues",
        model: "JiraIssue",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        path: "/jira/issues/fix-login-redirect__10001.json",
        semantics: expect.objectContaining({
          properties: expect.not.objectContaining({
            "jira.assignee_account_id": "acct-1",
            "jira.assignee_display_name": "Ada Lovelace",
            "jira.assignee_email": "ada@example.com",
          }),
        }),
      }),
    );
    const writeInput = vi.mocked(client.writeFile).mock.calls[0]?.[0];
    expect(writeInput).toBeDefined();
    const storedRecord = JSON.parse(writeInput?.content ?? "{}") as {
      fields?: Record<string, unknown>;
      changelog?: unknown;
    };
    expect(storedRecord.fields?.assignee).toBeNull();
    expect(storedRecord.fields?.reporter).toBeNull();
    expect(storedRecord.changelog).toBeUndefined();
    expect(objectContainsValue(storedRecord, "ada@example.com")).toBe(false);
    expect(objectContainsValue(storedRecord, "Ada Lovelace")).toBe(false);
    expect(objectContainsValue(storedRecord, "acct-1")).toBe(false);
  });

  it("returns an object when sanitizing a root Jira user profile record", () => {
    expect(
      sanitizeJiraRecordForStorage({
        accountId: "acct-1",
        displayName: "Ada Lovelace",
        emailAddress: "ada@example.com",
      }),
    ).toEqual({});
  });

  it("adds Jira issue key semantics to comments", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "comment-1",
        body: "Looks good.",
        issue: { id: "10001", key: "ENG-42" },
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "jira",
        providerConfigKey: "jira-relay",
        syncName: "fetch-comments",
        model: "JiraComment",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        semantics: expect.objectContaining({
          properties: expect.objectContaining({
            "jira.issue_key": "ENG-42",
          }),
        }),
      }),
    );
  });

  it("writes Confluence pages under the Relayfile Confluence root", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "123456",
        title: "Architecture Notes",
        spaceId: "SPACE1",
        status: "current",
        bodyStorage: "<p>Hello</p>",
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "confluence",
        providerConfigKey: "confluence-relay",
        syncName: "fetch-pages",
        model: "ConfluencePage",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        path: "/confluence/spaces/SPACE1/pages/architecture-notes__123456.json",
        semantics: expect.objectContaining({
          properties: expect.objectContaining({
            provider: "confluence",
            "confluence.object_type": "page",
            "confluence.space_id": "SPACE1",
            "confluence.title": "Architecture Notes",
          }),
        }),
      }),
    );
  });

  it("writes Confluence spaces with space-key semantics", async () => {
    const client = createClient();

    await writeProviderRecord(
      client,
      {
        id: "987",
        key: "ENG",
        name: "Engineering",
        _nango_metadata: { last_action: "UPDATED" },
      },
      createJob({
        provider: "confluence",
        providerConfigKey: "confluence-relay",
        syncName: "fetch-spaces",
        model: "ConfluenceSpace",
      }),
    );

    expect(client.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/confluence/spaces/engineering__987.json",
        semantics: expect.objectContaining({
          properties: expect.objectContaining({
            "confluence.object_type": "space",
            "confluence.space_key": "ENG",
          }),
        }),
      }),
    );
  });
});

describe("writeBatchToRelayfile", () => {
  it("continues through record-level failures and returns aggregate counts", async () => {
    const client = createClient();
    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "repo-1",
          full_name: "AgentWorkforce/cloud",
          _nango_metadata: { last_action: "ADDED" },
        },
        {
          id: "missing-repo",
          _nango_metadata: { last_action: "ADDED" },
        },
        {
          id: "repo-2",
          full_name: "AgentWorkforce/relayfile",
          _nango_metadata: { last_action: "DELETED" },
        },
      ],
      createJob(),
      { concurrency: 2 },
    );

    // One error is the intentionally malformed record; the second is the
    // now-observable auxiliary-emitter skip because this test client lacks
    // readFile, which production sync clients must provide.
    expect(result).toEqual({ written: 1, deleted: 1, errors: 2 });
    expect(client.writeFile).toHaveBeenCalledTimes(1);
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("emits GitHub issue by-edited aliases during batch sync", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-9",
          number: 9,
          full_name: "acme/platform",
          title: "Track lazy materialization",
          state: "open",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/github/repos/acme__platform/issues/by-edited/2026-05-11/9.json")).toBeDefined();
  });

  it("emits file-native Linear layout, index, and by-state aliases during batch sync", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-1",
          identifier: "AGENT-12",
          title: "Fix login bug",
          state_name: "In Progress",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        syncName: "fetch-active-issues",
        model: "LinearIssue",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/LAYOUT.md")).toContain("Relayfile Workspace Layout");
    expect(files.get("/linear/LAYOUT.md")).toContain("Linear Mount Layout");
    const linearByState = JSON.parse(
      files.get("/linear/issues/by-state/in-progress/AGENT-12.json") ?? "{}",
    ) as { payload?: Record<string, unknown> };
    const linearByEdited = JSON.parse(
      files.get("/linear/issues/by-edited/2026-05-11/issue-1.json") ?? "{}",
    ) as { payload?: Record<string, unknown> };
    const linearByUuid = JSON.parse(
      files.get("/linear/issues/by-uuid/issue-1.json") ?? "{}",
    ) as { payload?: Record<string, unknown> };
    expect(linearByState.payload).toMatchObject({
      id: "issue-1",
      identifier: "AGENT-12",
      title: "Fix login bug",
      state_name: "In Progress",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    expect(linearByEdited.payload).toMatchObject({
      id: "issue-1",
      identifier: "AGENT-12",
      title: "Fix login bug",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    expect(linearByUuid.payload).toMatchObject({
      id: "issue-1",
      identifier: "AGENT-12",
      title: "Fix login bug",
      state_name: "In Progress",
      updated_at: "2026-05-11T10:00:00.000Z",
    });
    expect(JSON.parse(files.get("/linear/issues/_index.json") ?? "[]")).toEqual([
      {
        id: "issue-1",
        title: "Fix login bug",
        updated: "",
        identifier: "AGENT-12",
        state: "In Progress",
      },
    ]);
  });

  it("uses current revisions for adapter auxiliary tombstone cleanup", async () => {
    const files = new Map<string, string>([
      [
        "/linear/issues/by-uuid/issue-1.json",
        JSON.stringify({
          provider: "linear",
          objectType: "issue",
          objectId: "issue-1",
          payload: {
            id: "issue-1",
            identifier: "AGENT-12",
            title: "Fix login bug",
            state_name: "Todo",
          },
        }),
      ],
      ["/linear/issues/by-state/todo/AGENT-12.json", "{}"],
    ]);
    const revisions = new Map(
      [...files.keys()].map((path, index) => [path, `rev_${index + 10}`]),
    );
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => {
        if (!files.has(path)) {
          throw { status: 404 };
        }
        return { content: files.get(path), revision: revisions.get(path) };
      }),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
      deleteFile: vi.fn().mockImplementation(async (input) => {
        files.delete(input.path);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-1",
          identifier: "AGENT-12",
          title: "Fix login bug",
          state_name: "Done",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        syncName: "fetch-active-issues",
        model: "LinearIssue",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(client.deleteFile).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      path: "/linear/issues/by-state/todo/AGENT-12.json",
      baseRevision: revisions.get("/linear/issues/by-state/todo/AGENT-12.json"),
    });
  });

  it("skips stale direct webhook records before canonical and auxiliary writes", async () => {
    const client = createClient({
      readFile: vi.fn().mockResolvedValue({
        revision: "rev_20",
        content: JSON.stringify({
          id: "issue-12",
          number: 12,
          full_name: "AgentWorkforce/cloud",
          title: "Newer state",
          state: "open",
          updated_at: "2026-05-15T12:00:00.000Z",
        }),
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-12",
          number: 12,
          full_name: "AgentWorkforce/cloud",
          title: "Older replay",
          state: "closed",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toEqual({ written: 0, deleted: 0, errors: 0 });
    // Stale record produced no canonical/alias/index mutation; the contract
    // surface (LAYOUT.md + discovery/) is materialized every sync and is
    // orthogonal to record staleness.
    expectNoRecordMutations(client);
  });

  it("skips stale direct webhook tombstones when the current record is newer", async () => {
    const client = createClient({
      readFile: vi.fn().mockResolvedValue({
        revision: "rev_21",
        content: JSON.stringify({
          id: "issue-12",
          number: 12,
          full_name: "AgentWorkforce/cloud",
          state: "open",
          updated_at: "2026-05-15T12:00:00.000Z",
        }),
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-12",
          number: 12,
          full_name: "AgentWorkforce/cloud",
          updated_at: "2026-05-15T10:00:00.000Z",
          _nango_metadata: { last_action: "DELETED" },
        },
      ],
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toEqual({ written: 0, deleted: 0, errors: 0 });
    // Stale tombstone produced no canonical/alias/index mutation; the
    // contract surface (LAYOUT.md + discovery/) is materialized every sync
    // and is orthogonal to record staleness.
    expectNoRecordMutations(client);
  });

  it("skips stale GitHub issue renames using the stable by-id alias", async () => {
    const readFile = vi.fn().mockImplementation(async (_workspaceId: string, path: string) => {
      if (path === "/github/repos/acme__platform/issues/by-id/9.json") {
        return {
          revision: "rev_30",
          content: JSON.stringify({
            id: "issue-9",
            number: 9,
            full_name: "acme/platform",
            title: "Newer title",
            updated_at: "2026-05-15T12:00:00.000Z",
          }),
        };
      }
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    });
    const client = createClient({ readFile });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-9",
          number: 9,
          full_name: "acme/platform",
          title: "Older title",
          updated_at: "2026-05-15T10:00:00.000Z",
        },
      ],
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toEqual({ written: 0, deleted: 0, errors: 0 });
    // Stale record produced no canonical/alias/index mutation; the contract
    // surface (LAYOUT.md + discovery/) is materialized every sync and is
    // orthogonal to record staleness.
    expectNoRecordMutations(client);
  });

  it("skips stale Linear issue renames using the stable by-uuid alias", async () => {
    const readFile = vi.fn().mockImplementation(async (_workspaceId: string, path: string) => {
      if (path === "/linear/issues/by-uuid/issue-12.json") {
        return {
          revision: "rev_31",
          content: JSON.stringify({
            id: "issue-12",
            title: "Newer title",
            updatedAt: "2026-05-15T12:00:00.000Z",
          }),
        };
      }
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    });
    const client = createClient({ readFile });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-12",
          title: "Older title",
          updatedAt: "2026-05-15T10:00:00.000Z",
        },
      ],
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        syncName: "fetch-active-issues",
        model: "LinearIssue",
      }),
    );

    expect(result).toEqual({ written: 0, deleted: 0, errors: 0 });
    // Stale record produced no canonical/alias/index mutation; the contract
    // surface (LAYOUT.md + discovery/) is materialized every sync and is
    // orthogonal to record staleness.
    expectNoRecordMutations(client);
  });

  it("removes stale Linear aliases and slugged issue files for deleted issue records", async () => {
    const files = new Map<string, string>([
      [
        "/linear/issues/_index.json",
        JSON.stringify([
          {
            id: "issue-1",
            title: "Fix login bug",
            updated: "2026-05-11T10:00:00.000Z",
            identifier: "AGENT-12",
            state: "In Progress",
          },
        ]),
      ],
      [
        "/linear/issues/by-id/AGENT-12.json",
        JSON.stringify({
          id: "issue-1",
          identifier: "AGENT-12",
          title: "Fix login bug",
          state_name: "In Progress",
        }),
      ],
      ["/linear/issues/by-title/fix-login-bug.json", "{}"],
      ["/linear/issues/by-state/in-progress/AGENT-12.json", "{}"],
      ["/linear/issues/AGENT-12__issue-1.json", "{}"],
    ]);
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
      deleteFile: vi.fn().mockImplementation(async (input) => {
        files.delete(input.path);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [{ id: "issue-1", _nango_metadata: { last_action: "DELETED" } }],
      createJob({
        provider: "linear",
        providerConfigKey: "linear-relay",
        syncName: "fetch-active-issues",
        model: "LinearIssue",
      }),
    );

    expect(result).toEqual({ written: 0, deleted: 1, errors: 0 });
    expect(client.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/linear/issues/issue-1.json" }),
    );
    expect(client.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/linear/issues/by-uuid/issue-1.json" }),
    );
    expect(JSON.parse(files.get("/linear/issues/_index.json") ?? "[]")).toEqual([]);
  });

  it("removes stale GitHub aliases and slugged issue files for deleted issue records", async () => {
    const files = new Map<string, string>([
      [
        "/github/repos/acme/platform/issues/_index.json",
        JSON.stringify([
          {
            id: "9",
            title: "Track lazy materialization",
            updated: "2026-05-11T10:00:00.000Z",
            number: 9,
            state: "open",
          },
        ]),
      ],
      [
        "/github/repos/acme__platform/issues/by-id/9.json",
        JSON.stringify({
          id: "issue-9",
          number: 9,
          full_name: "acme/platform",
          title: "Track lazy materialization",
        }),
      ],
      ["/github/repos/acme__platform/issues/by-title/track-lazy-materialization.json", "{}"],
      ["/github/repos/acme/platform/issues/9__track-lazy-materialization/meta.json", "{}"],
    ]);
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
      deleteFile: vi.fn().mockImplementation(async (input) => {
        files.delete(input.path);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "issue-9",
          number: 9,
          full_name: "acme/platform",
          _nango_metadata: { last_action: "DELETED" },
        },
      ],
      createJob({ model: "Issue", syncName: "fetch-open-issues" }),
    );

    expect(result).toEqual({ written: 0, deleted: 1, errors: 0 });
    expect(client.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/github/repos/acme/platform/issues/9/meta.json",
      }),
    );
    expect(client.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/github/repos/acme/platform/issues/9/meta.json",
      }),
    );
    expect(JSON.parse(files.get("/github/repos/acme/platform/issues/_index.json") ?? "[]")).toEqual([]);
  });

  it("emits Notion layout and page indexes during batch sync", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "page-1",
          title: "Launch notes",
          lastEditedTime: "2026-05-11T11:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "notion",
        providerConfigKey: "notion-relay",
        syncName: "fetch-pages",
        model: "NotionPage",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/notion/LAYOUT.md")).toContain("Notion Mount Layout");
    expect(JSON.parse(files.get("/notion/pages/_index.json") ?? "[]")).toEqual([
      {
        id: "page-1",
        title: "Launch notes",
        updated: "2026-05-11T11:00:00.000Z",
        parent_id: null,
        parent_type: "workspace",
      },
    ]);
  });

  it("emits Notion page by-id, by-title, by-database, and by-parent aliases", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Launch checklist",
          lastEditedTime: "2026-05-11T11:00:00.000Z",
          parent_type: "database",
          parent_id: "22222222-2222-4222-8222-222222222222",
          databaseId: "22222222-2222-4222-8222-222222222222",
          databaseTitle: "Tasks",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      createJob({
        provider: "notion",
        providerConfigKey: "notion-relay",
        syncName: "fetch-pages",
        model: "NotionPage",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    // by-id alias under the standalone pages collection (the alias helper
    // dehyphenates the UUID for the filename).
    const byIdMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-id/"),
    );
    expect(byIdMatch, `expected a /notion/pages/by-id/ alias, got: ${[...files.keys()].join(", ")}`).toBeDefined();
    // by-title alias slugifies the title and appends `__<short_id>`.
    const byTitleMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-title/launch-checklist__"),
    );
    expect(byTitleMatch).toBeDefined();
    // by-database alias under the database's slug__short bucket.
    const byDatabaseMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-database/tasks__"),
    );
    expect(byDatabaseMatch).toBeDefined();
    const byEditedMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-edited/2026-05-11/"),
    );
    expect(byEditedMatch).toBeDefined();
    // by-parent is INTENTIONALLY not emitted when the parent is a database.
    // adapter-notion's `pagePathsFor` (in `emit-auxiliary-files.ts`) guards
    // `if (parentType === 'page' && parentId && title)` because database-
    // rooted pages are already covered by the `by-database/<db>/...` alias
    // above — emitting both would duplicate-write every database row under
    // `/notion/pages/by-parent/database-<slug>/`. The previous assertion
    // here expected the by-parent emission to fire for database parents,
    // but that was specced before the deduplication landed in adapter
    // 0.2.7. Locking in the ABSENCE.
    const byParentDatabaseMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-parent/database-"),
    );
    expect(byParentDatabaseMatch).toBeUndefined();
    // Index row carries parent_id + parent_type per the LAYOUT spec.
    expect(JSON.parse(files.get("/notion/pages/_index.json") ?? "[]")).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Launch checklist",
        updated: "2026-05-11T11:00:00.000Z",
        parent_id: "22222222-2222-4222-8222-222222222222",
        parent_type: "database",
      },
    ]);
  });

  it("emits Notion user by-name and bots aliases for bot users", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Notifier Bot",
          type: "bot",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      createJob({
        provider: "notion",
        providerConfigKey: "notion-relay",
        syncName: "fetch-users",
        model: "NotionUser",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    const byNameMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/users/by-name/notifier-bot__"),
    );
    expect(byNameMatch, `expected /notion/users/by-name/ alias; got: ${[...files.keys()].join(", ")}`).toBeDefined();
    const byIdMatch = [...files.keys()].find((p) =>
      p.startsWith("/notion/users/by-id/"),
    );
    expect(byIdMatch).toBeDefined();
  });

  it("emits Slack channel by-name alias, channels index, root index, and LAYOUT", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "C0ADE9B71CN",
          name: "general",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-channels",
        model: "SlackChannel",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/slack/LAYOUT.md")).toContain("Slack Mount Layout");
    // Root index — static listing of provider resource roots.
    const rootIndex = JSON.parse(files.get("/slack/_index.json") ?? "[]");
    expect(rootIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "channels" }),
        expect.objectContaining({ name: "users" }),
      ]),
    );
    // Channels index lists the channel by id + display name.
    const channelsIndex = JSON.parse(files.get("/slack/channels/_index.json") ?? "[]");
    expect(channelsIndex).toEqual([
      expect.objectContaining({ id: "C0ADE9B71CN", title: "general" }),
    ]);
    // by-name alias for the channel.
    const byNameMatch = [...files.keys()].find((p) =>
      p.startsWith("/slack/channels/by-name/general"),
    );
    expect(byNameMatch, `expected /slack/channels/by-name/ alias; got: ${[...files.keys()].join(", ")}`).toBeDefined();
  });

  it("skips Slack replay writes when only volatile webhook receipt metadata changed", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => {
        const content = files.get(path);
        return content === undefined ? null : { content };
      }),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });
    const job = createJob({
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channel-history",
      model: "SlackMessage",
    });
    const record = {
      id: "C0AD7UU0J1G:1780687762.971029",
      channel: "C0AD7UU0J1G",
      ts: "1780687762.971029",
      text: "aaaa",
      user: "U123",
      thread_ts: null,
      reply_count: 0,
      _webhook: {
        eventType: "message.created",
        action: "created",
        receivedAt: "2026-06-05T19:31:00.000Z",
      },
    };

    await expect(writeProviderRecord(client, record, job)).resolves.toBe("written");
    await expect(writeProviderRecord(
      client,
      {
        ...record,
        _webhook: {
          ...record._webhook,
          receivedAt: "2026-06-05T19:47:00.000Z",
        },
      },
      job,
    )).resolves.toBe("skipped");

    expect(client.writeFile).toHaveBeenCalledTimes(1);
  });

  it("emits Slack user by-name alias and bots alias for bot users", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "U0BOT01",
          name: "notifier",
          is_bot: true,
          profile: { display_name: "Notifier", real_name: "Notifier Bot" },
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
        {
          id: "U0HUMAN1",
          name: "alice",
          is_bot: false,
          profile: { display_name: "Alice", real_name: "Alice Chen" },
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-users",
        model: "SlackUser",
      }),
    );

    expect(result).toEqual({ written: 2, deleted: 0, errors: 0 });
    // Both users get by-name aliases.
    const byNameNotifier = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/by-name/notifier"),
    );
    expect(byNameNotifier).toBeDefined();
    const byNameAlice = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/by-name/alice"),
    );
    expect(byNameAlice).toBeDefined();
    // Only the bot lands under bots/.
    const botsMatch = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/bots/"),
    );
    expect(botsMatch).toBeDefined();
    const humanInBots = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/bots/") && p.includes("U0HUMAN1"),
    );
    expect(humanInBots).toBeUndefined();
    // Users index carries is_bot per row.
    const usersIndex = JSON.parse(files.get("/slack/users/_index.json") ?? "[]");
    expect(usersIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "U0BOT01", is_bot: true }),
        expect.objectContaining({ id: "U0HUMAN1", is_bot: false }),
      ]),
    );
  });

  it("emits Jira by-id/by-key/by-state issue aliases and issues index", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "10001",
          key: "KAN-12",
          fields: {
            summary: "Wire alias subtrees",
            status: { name: "In Progress" },
            updated: "2026-05-11T10:00:00.000Z",
          },
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "jira",
        providerConfigKey: "jira-relay",
        syncName: "fetch-issues",
        model: "JiraIssue",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/jira/issues/by-id/10001.json")).toBeDefined();
    expect(files.get("/jira/issues/by-key/KAN-12.json")).toBeDefined();
    expect(files.get("/jira/issues/by-state/in-progress/10001.json")).toBeDefined();
    expect(files.get("/jira/issues/by-edited/2026-05-11/10001.json")).toBeDefined();
    const issuesIndex = JSON.parse(files.get("/jira/issues/_index.json") ?? "[]");
    expect(issuesIndex).toEqual([
      expect.objectContaining({
        id: "10001",
        key: "KAN-12",
        state: "In Progress",
      }),
    ]);
  });

  it("emits Confluence page by-space and by-parent aliases", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "987654",
          title: "Onboarding",
          status: "current",
          spaceId: "100",
          parentId: "987000",
          version: { createdAt: "2026-05-11T10:00:00.000Z" },
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "confluence",
        providerConfigKey: "confluence-relay",
        syncName: "fetch-pages",
        model: "Page",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/confluence/pages/by-id/987654.json")).toBeDefined();
    expect(files.get("/confluence/pages/by-state/current/987654.json")).toBeDefined();
    expect(files.get("/confluence/pages/by-space/100/987654.json")).toBeDefined();
    expect(files.get("/confluence/pages/by-parent/987000/987654.json")).toBeDefined();
    expect(files.get("/confluence/pages/by-edited/2026-05-11/987654.json")).toBeDefined();
  });

  it("emits Confluence space by-id/by-title/by-key aliases and spaces index", async () => {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
    });

    const result = await writeBatchToRelayfile(
      client,
      [
        {
          id: "100",
          key: "ENG",
          name: "Engineering",
          type: "global",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      createJob({
        provider: "confluence",
        providerConfigKey: "confluence-relay",
        syncName: "fetch-spaces",
        model: "Space",
      }),
    );

    expect(result).toEqual({ written: 1, deleted: 0, errors: 0 });
    expect(files.get("/confluence/spaces/by-id/100.json")).toBeDefined();
    expect(files.get("/confluence/spaces/by-key/ENG.json")).toBeDefined();
    // by-title alias has the slug__id form.
    const byTitleMatch = [...files.keys()].find((p) =>
      p.startsWith("/confluence/spaces/by-title/engineering"),
    );
    expect(byTitleMatch).toBeDefined();
  });

  // -- Alias reconciliation on rename / move / delete --------------------
  // These tests exercise the prior-state read pattern shared by all five
  // CodeRabbit + Devin findings on cloud#546: write a record, write the
  // same id again with new key material, then assert the OLD alias paths
  // are cleaned up before the new ones are emitted.

  function createReconciliationClient() {
    const files = new Map<string, string>();
    const client = createClient({
      readFile: vi.fn().mockImplementation(async (_workspaceId: string, path: string) => ({
        content: files.get(path) ?? "",
      })),
      writeFile: vi.fn().mockImplementation(async (input) => {
        files.set(input.path, input.content);
      }),
      deleteFile: vi.fn().mockImplementation(async (input) => {
        files.delete(input.path);
      }),
    });
    return { files, client };
  }

  it("reconciles Notion page aliases when the title changes", async () => {
    const { files, client } = createReconciliationClient();
    const pageId = "11111111-1111-4111-8111-111111111111";
    const job = createJob({
      provider: "notion",
      providerConfigKey: "notion-relay",
      syncName: "fetch-pages",
      model: "NotionPage",
    });

    // First write — title A, no parent.
    await writeBatchToRelayfile(
      client,
      [
        {
          id: pageId,
          title: "Original Title",
          lastEditedTime: "2026-05-11T10:00:00.000Z",
          parent_type: "workspace",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    const oldByTitle = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-title/original-title__"),
    );
    expect(oldByTitle, `expected old by-title alias for "original-title"`).toBeDefined();

    // Second write — same id, renamed to "Renamed Title".
    await writeBatchToRelayfile(
      client,
      [
        {
          id: pageId,
          title: "Renamed Title",
          lastEditedTime: "2026-05-11T11:00:00.000Z",
          parent_type: "workspace",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      job,
    );

    // Old by-title alias must be gone; new one must be present.
    expect(files.has(oldByTitle as string)).toBe(false);
    const newByTitle = [...files.keys()].find((p) =>
      p.startsWith("/notion/pages/by-title/renamed-title__"),
    );
    expect(newByTitle).toBeDefined();
  });

  it("reconciles Notion user aliases when display name changes", async () => {
    const { files, client } = createReconciliationClient();
    const userId = "33333333-3333-4333-8333-333333333333";
    const job = createJob({
      provider: "notion",
      providerConfigKey: "notion-relay",
      syncName: "fetch-users",
      model: "NotionUser",
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: userId,
          name: "Notifier Bot",
          type: "bot",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    const oldByName = [...files.keys()].find((p) =>
      p.startsWith("/notion/users/by-name/notifier-bot__"),
    );
    expect(oldByName).toBeDefined();
    // Canonical id-only user path must exist (id-stable, no slug prefix).
    expect(files.get(`/notion/users/${userId}.json`)).toBeDefined();

    await writeBatchToRelayfile(
      client,
      [
        {
          id: userId,
          name: "Renamed Bot",
          type: "bot",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      job,
    );

    expect(files.has(oldByName as string)).toBe(false);
    const newByName = [...files.keys()].find((p) =>
      p.startsWith("/notion/users/by-name/renamed-bot__"),
    );
    expect(newByName).toBeDefined();
    // Canonical user file is still at the id-only path (no orphan from rename).
    expect(files.get(`/notion/users/${userId}.json`)).toBeDefined();
    const orphanSlugged = [...files.keys()].find(
      (p) =>
        p.startsWith("/notion/users/notifier-bot__") ||
        p.startsWith("/notion/users/renamed-bot__"),
    );
    expect(orphanSlugged).toBeUndefined();
  });

  it("reconciles Confluence space aliases when title and key change", async () => {
    const { files, client } = createReconciliationClient();
    const spaceId = "100";
    const job = createJob({
      provider: "confluence",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-spaces",
      model: "Space",
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: spaceId,
          key: "ENG",
          name: "Engineering",
          type: "global",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    expect(files.get("/confluence/spaces/by-key/ENG.json")).toBeDefined();
    const oldByTitle = [...files.keys()].find((p) =>
      p.startsWith("/confluence/spaces/by-title/engineering"),
    );
    expect(oldByTitle).toBeDefined();

    await writeBatchToRelayfile(
      client,
      [
        {
          id: spaceId,
          key: "PLAT",
          name: "Platform",
          type: "global",
          updated_at: "2026-05-11T11:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      job,
    );

    // Old by-key + by-title aliases must be cleaned up.
    expect(files.has("/confluence/spaces/by-key/ENG.json")).toBe(false);
    expect(files.has(oldByTitle as string)).toBe(false);
    // New aliases present.
    expect(files.get("/confluence/spaces/by-key/PLAT.json")).toBeDefined();
    const newByTitle = [...files.keys()].find((p) =>
      p.startsWith("/confluence/spaces/by-title/platform"),
    );
    expect(newByTitle).toBeDefined();
  });

  it("emits Slack root index even when only messages sync", async () => {
    const { files, client } = createReconciliationClient();
    await writeBatchToRelayfile(
      client,
      [
        {
          id: "M1",
          channel: "C1",
          ts: "1700000000.000100",
          text: "hello",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      createJob({
        provider: "slack",
        providerConfigKey: "slack-relay",
        syncName: "fetch-messages",
        model: "SlackMessage",
      }),
    );
    // Root index reconciles for every Slack sync, regardless of model.
    expect(files.get("/slack/_index.json")).toBeDefined();
  });

  it("reconciles Slack channel by-name alias on rename", async () => {
    const { files, client } = createReconciliationClient();
    const channelId = "C0RENAME01";
    const job = createJob({
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channels",
      model: "SlackChannel",
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: channelId,
          name: "old-name",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    const oldAlias = [...files.keys()].find((p) =>
      p.startsWith("/slack/channels/by-name/old-name"),
    );
    expect(oldAlias).toBeDefined();

    await writeBatchToRelayfile(
      client,
      [
        {
          id: channelId,
          name: "new-name",
          updated_at: "2026-05-11T11:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      job,
    );

    expect(files.has(oldAlias as string)).toBe(false);
    const newAlias = [...files.keys()].find((p) =>
      p.startsWith("/slack/channels/by-name/new-name"),
    );
    expect(newAlias).toBeDefined();
  });

  it("reconciles Slack channel by-name alias on delete tombstone with no name", async () => {
    const { files, client } = createReconciliationClient();
    const channelId = "C0DELTOMBSTONE";
    const job = createJob({
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channels",
      model: "SlackChannel",
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: channelId,
          name: "doomed",
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    const oldAlias = [...files.keys()].find((p) =>
      p.startsWith("/slack/channels/by-name/doomed"),
    );
    expect(oldAlias).toBeDefined();

    // Nango delete tombstone with no `name` field — prior name must come
    // from the channels index row we wrote on the previous sync.
    await writeBatchToRelayfile(
      client,
      [
        {
          id: channelId,
          _nango_metadata: { last_action: "DELETED" },
        },
      ],
      job,
    );

    expect(files.has(oldAlias as string)).toBe(false);
  });

  it("reconciles Slack user by-name + bots aliases on rename and bot-flip", async () => {
    const { files, client } = createReconciliationClient();
    const userId = "U0RENAME01";
    const job = createJob({
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-users",
      model: "SlackUser",
    });

    await writeBatchToRelayfile(
      client,
      [
        {
          id: userId,
          name: "oldhandle",
          is_bot: true,
          profile: { display_name: "Old Handle" },
          updated_at: "2026-05-11T10:00:00.000Z",
          _nango_metadata: { last_action: "ADDED" },
        },
      ],
      job,
    );
    const oldByName = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/by-name/oldhandle"),
    );
    const oldBots = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/bots/") && p.includes("oldhandle"),
    );
    expect(oldByName).toBeDefined();
    expect(oldBots).toBeDefined();

    // Rename + bot-flip.
    await writeBatchToRelayfile(
      client,
      [
        {
          id: userId,
          name: "newhandle",
          is_bot: false,
          profile: { display_name: "New Handle" },
          updated_at: "2026-05-11T11:00:00.000Z",
          _nango_metadata: { last_action: "UPDATED" },
        },
      ],
      job,
    );

    expect(files.has(oldByName as string)).toBe(false);
    expect(files.has(oldBots as string)).toBe(false);
    const newByName = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/by-name/newhandle"),
    );
    expect(newByName).toBeDefined();
    // No bot alias for a non-bot user.
    const newBots = [...files.keys()].find((p) =>
      p.startsWith("/slack/users/bots/") && p.includes(userId),
    );
    expect(newBots).toBeUndefined();
  });
});
