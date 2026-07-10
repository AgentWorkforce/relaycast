import {
  RelayFileApiError,
  type FileReadResponse,
  type FileSemantics,
  type WriteFileInput,
} from "@relayfile/sdk";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LINEAR_LAYOUT_MD } from "../src/conventions.js";
import { buildIndexRows, writeDirectoryIndex, writeIntegrationLayout } from "../src/index-emitter.js";

const WORKSPACE_ID = "workspace_123";

describe("linear index emitter", () => {
  it("first-write 404 emits a stable _index.json with the adapter row shape", async () => {
    const client = createFakeClient();

    const result = await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries: [
        {
          path: "/linear/issues/alpha__1.json",
          content: {
            id: "lin_1",
            identifier: "ENG-1",
            title: "Alpha one",
            updatedAt: "2026-04-20T10:00:00.000Z",
            state: { name: "In Progress" },
          },
        },
        { path: "/linear/issues/_index.json", content: [] },
        {
          path: "/linear/issues/alpha__2.json",
          content: {
            id: "lin_2",
            identifier: "ENG-2",
            title: "Alpha two",
            updatedAt: "2026-04-20T11:00:00.000Z",
            state: { type: "started" },
          },
        },
        { path: "/linear/issues/beta.json", content: { title: "Beta", updatedAt: "2026-04-19T09:00:00.000Z" } },
      ],
    });

    assert.equal(result.status, "written");
    assert.equal(client.writeFile.calls.length, 1);
    const written = getSingleCallArgument<WriteFileInput>(client.writeFile);
    assertMatchesSubset(written, {
      path: "/linear/issues/_index.json",
      baseRevision: "0",
      contentType: "application/json; charset=utf-8",
    });
    const payload = JSON.parse(String(written.content)) as Array<Record<string, unknown>>;
    assert.deepEqual(payload.map((entry) => entry.id), ["lin_1", "lin_2", "beta"]);
    assert.deepEqual(Object.keys(payload[0] ?? {}).sort(), [
      "id",
      "identifier",
      "state",
      "title",
      "updated",
    ]);
    assertMatchesSubset(payload[0], {
      identifier: "ENG-1",
      state: "In Progress",
      updated: "2026-04-20T10:00:00.000Z",
    });
  });

  it("keeps duplicate decoded names distinct via id", async () => {
    const client = createFakeClient();

    await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries: [
        {
          path: "/linear/issues/customer%20sync__issue-1.json",
          content: { title: "Customer sync issue 1", updatedAt: "2026-04-20T10:00:00.000Z" },
        },
        {
          path: "/linear/issues/customer%20sync__issue-2.json",
          content: { title: "Customer sync issue 2", updatedAt: "2026-04-20T11:00:00.000Z" },
        },
      ],
    });

    const payload = JSON.parse(String(getSingleCallArgument<WriteFileInput>(client.writeFile).content)) as Array<
      Record<string, unknown>
    >;
    assert.equal(payload.length, 2);
    assertMatchesSubset(payload[0], { id: "issue-1", title: "Customer sync issue 1" });
    assertMatchesSubset(payload[1], { id: "issue-2", title: "Customer sync issue 2" });
  });

  it("skips a repeat write when the fingerprint matches", async () => {
    const client = createFakeClient();
    const entries = [{ path: "/linear/issues/alpha.json", content: { title: "Alpha" } }];

    await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries,
    });
    client.writeFile.calls.length = 0;

    const result = await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries,
    });

    assert.equal(result.status, "skipped");
    assert.equal(client.writeFile.calls.length, 0);
  });

  it("rewrites the index with the prior revision when entries change", async () => {
    const client = createFakeClient();

    await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries: [{ path: "/linear/issues/alpha.json", content: { title: "Alpha" } }],
    });
    client.writeFile.calls.length = 0;

    await writeDirectoryIndex({
      client,
      workspaceId: WORKSPACE_ID,
      directoryPath: "/linear/issues",
      entries: [
        { path: "/linear/issues/alpha.json", content: { title: "Alpha" } },
        { path: "/linear/issues/beta.json", content: { title: "Beta" } },
      ],
    });

    assert.equal(getSingleCallArgument<WriteFileInput>(client.writeFile).baseRevision, "1");
  });

  it("propagates 412 write conflicts", async () => {
    const readFile = createTrackedAsyncFn(async (_workspaceId: string, path: string): Promise<FileReadResponse> => ({
      path,
      revision: "7",
      content: "[]\n",
      contentType: "application/json; charset=utf-8",
      encoding: "utf-8",
    }));
    const writeFile = createTrackedAsyncFn(async (_input: WriteFileInput) => {
      throw new RelayFileApiError(412, { code: "revision_mismatch", message: "stale revision" });
    });
    const client = { readFile, writeFile };

    await assert.rejects(
      writeDirectoryIndex({
        client,
        workspaceId: WORKSPACE_ID,
        directoryPath: "/linear/issues",
        entries: [{ path: "/linear/issues/alpha.json", content: { title: "Alpha" } }],
      }),
      (error: unknown) => error instanceof RelayFileApiError && error.status === 412,
    );
    assertMatchesSubset(getSingleCallArgument<WriteFileInput>(client.writeFile), {
      path: "/linear/issues/_index.json",
      baseRevision: "7",
    });
  });

  it("keeps malformed or missing leaf json entries with null metadata", () => {
    const rows = buildIndexRows([
      { path: "/linear/comments/broken.json", content: "{not valid json" },
      { path: "/linear/comments/missing.json", content: null },
    ]);

    assert.deepEqual(rows, [
      { id: "broken", title: "broken", updated: "" },
      { id: "missing", title: "missing", updated: "" },
    ]);
  });

  it("writes canonical LAYOUT.md with baseRevision 0 on the first run", async () => {
    const client = createFakeClient();

    const result = await writeIntegrationLayout({
      client,
      workspaceId: WORKSPACE_ID,
      path: "/linear/LAYOUT.md",
      body: LINEAR_LAYOUT_MD,
    });

    assert.equal(result.status, "written");
    assertMatchesSubset(getSingleCallArgument<WriteFileInput>(client.writeFile), {
      path: "/linear/LAYOUT.md",
      baseRevision: "0",
      contentType: "text/markdown",
    });
  });

  it("canonicalizes legacy .layout.md layout writes", async () => {
    const client = createFakeClient();

    const result = await writeIntegrationLayout({
      client,
      workspaceId: WORKSPACE_ID,
      path: "/linear/.layout.md",
      body: LINEAR_LAYOUT_MD,
    });

    assert.equal(result.path, "/linear/LAYOUT.md");
    assertMatchesSubset(getSingleCallArgument<WriteFileInput>(client.writeFile), {
      path: "/linear/LAYOUT.md",
    });
  });
});

interface FakeClient {
  readFile: TrackedAsyncFn<[string, string], FileReadResponse>;
  writeFile: TrackedAsyncFn<[WriteFileInput], { opId: string; status: "queued"; targetRevision: string }>;
}

function createFakeClient(): FakeClient {
  const files = new Map<string, { revision: string; content: string; semantics?: FileSemantics; contentType: string }>();
  let revisionCounter = 0;

  const readFile = createTrackedAsyncFn(async (_workspaceId: string, path: string): Promise<FileReadResponse> => {
    const existing = files.get(path);
    if (!existing) {
      throw new RelayFileApiError(404, { code: "not_found", message: "not found" });
    }
    return {
      path,
      revision: existing.revision,
      content: existing.content,
      contentType: existing.contentType,
      encoding: "utf-8",
      semantics: existing.semantics,
    };
  });

  const writeFile = createTrackedAsyncFn(async (input: WriteFileInput) => {
    revisionCounter += 1;
    files.set(input.path, {
      revision: String(revisionCounter),
      content: input.content as string,
      semantics: input.semantics,
      contentType: input.contentType ?? "application/octet-stream",
    });
    return {
      opId: `op_${revisionCounter}`,
      status: "queued" as const,
      targetRevision: String(revisionCounter),
    };
  });

  return { readFile, writeFile };
}

type TrackedAsyncFn<Args extends unknown[], Result> = ((...args: Args) => Promise<Result>) & {
  calls: Args[];
};

function createTrackedAsyncFn<Args extends unknown[], Result>(
  implementation: (...args: Args) => Promise<Result>,
): TrackedAsyncFn<Args, Result> {
  const calls: Args[] = [];
  const tracked = (async (...args: Args) => {
    calls.push(args);
    return implementation(...args);
  }) as TrackedAsyncFn<Args, Result>;
  tracked.calls = calls;
  return tracked;
}

function getSingleCallArgument<T>(fn: { calls: Array<unknown[]> }, callIndex = 0): T {
  const call = fn.calls[callIndex];
  assert.ok(call, `expected a call at index ${callIndex}`);
  return call?.[0] as T;
}

function assertMatchesSubset(actual: unknown, expected: unknown): void {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    assert.deepEqual(actual, expected);
    return;
  }

  assert.ok(actual && typeof actual === "object");
  for (const [key, value] of Object.entries(expected)) {
    assertMatchesSubset((actual as Record<string, unknown>)[key], value);
  }
}
