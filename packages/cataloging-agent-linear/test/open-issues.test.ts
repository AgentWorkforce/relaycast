import type { CatalogingContext } from "@cloud/cataloging-agent-core";
import {
  RelayFileApiError,
  type FileReadResponse,
  type FileSemantics,
  type TreeEntry,
  type TreeResponse,
} from "@relayfile/sdk";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { openIssuesInsight } from "../src/insights/open-issues.js";

const WORKSPACE_ID = "workspace_123";
const NOW = new Date("2026-04-21T12:00:00.000Z");
const OUTPUT_PATH = "/insights/linear/open-issues.json";
const SIGNAL_FINGERPRINT_PROPERTY = "cataloging.signalFingerprint";

interface OpenIssuesContent {
  generatedAt: string;
  summary: string;
  highlights: Array<{ kind: string; headline: string; issues: Array<Record<string, unknown>> }>;
  metrics: { openCount: number; p1Count: number; unassignedCount: number; p50AgeDays: number };
  all: Array<Record<string, unknown>>;
}

interface InsightWritePayload {
  content: OpenIssuesContent;
  contentType: string;
  semantics?: FileSemantics;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("openIssuesInsight", () => {
  it("returns an empty insight when there are no issues or comments", async () => {
    const { context, relayfile } = createHarness({});

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.ok(
      relayfile.listTree.calls.some(
        ([workspaceId, options]) =>
          workspaceId === WORKSPACE_ID &&
          matchesSubset(options, {
            path: "/linear/issues",
            depth: 2,
            correlationId: "insight:open-issues",
          }),
      ),
    );
    assertMatchesSubset(output.content, {
      generatedAt: NOW.toISOString(),
      highlights: [],
      metrics: { openCount: 0, p1Count: 0, unassignedCount: 0, p50AgeDays: 0 },
      all: [],
    });
    assert.ok(output.content.summary.length > 0);
    assert.match(
      String(output.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY]),
      /^sha256:/,
    );
  });

  it("returns the empty state when the issue and comment trees return 404", async () => {
    const { context } = createHarness({}, {
      missingTreePaths: ["/linear/issues", "/linear/comments"],
    });

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(output.content.metrics, {
      openCount: 0,
      p1Count: 0,
      unassignedCount: 0,
      p50AgeDays: 0,
    });
    assert.deepEqual(output.content.all, []);
    assert.deepEqual(output.content.highlights, []);
  });

  it("emits the redesigned shape with bucketed highlights, metrics, and a flat all list", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: "ENG-100 is high-priority and unassigned; CS-77 mentions enterprise.",
            },
          },
        ],
      }),
    );

    const { context } = createHarness(issueAndCommentFixtures(), {
      env: { OPENROUTER_API_KEY: "key_test" },
    });

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.equal(output.content.generatedAt, NOW.toISOString());
    assert.equal(
      output.content.summary,
      "ENG-100 is high-priority and unassigned; CS-77 mentions enterprise.",
    );
    assert.match(
      String(output.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY]),
      /^sha256:/,
    );

    const ids = output.content.all
      .map((issue) => issue.identifier)
      .filter((id): id is string => typeof id === "string")
      .sort();
    assert.deepEqual(ids, ["CS-77", "ENG-100", "ENG-101", "ENG-200"]);

    assert.equal(output.content.metrics.openCount, 4);
    assert.equal(output.content.metrics.p1Count, 1);
    assert.equal(output.content.metrics.unassignedCount, 2);
    assert.equal(typeof output.content.metrics.p50AgeDays, "number");

    const byKind = Object.fromEntries(output.content.highlights.map((h) => [h.kind, h]));

    const unassignedPriority = byKind["unassigned-priority"];
    assert.ok(unassignedPriority);
    assert.deepEqual(
      unassignedPriority.issues
        .map((issue) => issue.identifier)
        .slice()
        .sort(),
      ["ENG-100", "ENG-101"],
    );

    const staleNoActivity = byKind["stale-no-activity"];
    assert.ok(staleNoActivity);
    assert.ok(
      staleNoActivity.issues.some((issue) => issue.identifier === "ENG-200"),
      "expected ENG-200 in stale-no-activity issues",
    );

    const customerMentioned = byKind["customer-mentioned"];
    assert.ok(customerMentioned);
    assert.ok(
      customerMentioned.issues.some((issue) =>
        matchesSubset(issue, { identifier: "CS-77", customer: "enterprise" }),
      ),
      "expected CS-77 enterprise mention in customer-mentioned issues",
    );

    assert.equal(fetchMock.calls.length, 1);
    const [url] = fetchMock.calls[0] ?? [];
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
  });

  it("falls back to a deterministic summary when the LLM returns a non-2xx", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(503, { error: "unavailable" }));

    const { context } = createHarness(issueAndCommentFixtures(), {
      env: { OPENROUTER_API_KEY: "key_test" },
    });

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.equal(fetchMock.calls.length, 1);
    assert.match(output.content.summary, /need attention|See highlights/);
    assert.ok(output.content.highlights.length > 0);
    assert.ok(output.content.all.length > 0);
  });

  it("uses the cached summary on a second invocation with identical inputs (LLM called once)", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: "Cached linear summary from LLM." } }],
      }),
    );

    const harness = createHarness(issueAndCommentFixtures(), {
      env: { OPENROUTER_API_KEY: "key_test" },
    });

    const first = (await openIssuesInsight.generate(harness.context)) as InsightWritePayload;
    assert.equal(first.content.summary, "Cached linear summary from LLM.");
    assert.equal(fetchMock.calls.length, 1);
    const fingerprint = first.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY];
    assert.ok(fingerprint);

    harness.setOutputFile({
      content: JSON.stringify(first.content),
      semantics: { properties: { [SIGNAL_FINGERPRINT_PROPERTY]: fingerprint } },
    });

    const second = (await openIssuesInsight.generate(harness.context)) as InsightWritePayload;
    assert.equal(second.content.summary, "Cached linear summary from LLM.");
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(second.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY], fingerprint);
  });

  it("does not double-count issue aliases mirrored under by-title and by-id", async () => {
    const { context } = createHarness(issueAndCommentFixturesWithAliases());

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.equal(output.content.metrics.openCount, 4);
    assert.deepEqual(
      output.content.all
        .map((issue) => issue.identifier)
        .slice()
        .sort(),
      ["CS-77", "ENG-100", "ENG-101", "ENG-200"],
    );
  });

  it("returns the empty state when only issue alias trees are present", async () => {
    const { context } = createHarness(issueAliasOnlyFixtures());

    const output = (await openIssuesInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(output.content.metrics, {
      openCount: 0,
      p1Count: 0,
      unassignedCount: 0,
      p50AgeDays: 0,
    });
    assert.deepEqual(output.content.all, []);
    assert.deepEqual(output.content.highlights, []);
  });
});

type JsonFixtureMap = Record<string, Record<string, unknown>>;

function issueAndCommentFixtures(): JsonFixtureMap {
  return {
    // ENG-100 — priority 1, unassigned, recent: trips unassigned-priority.
    "/linear/issues/ENG-100.json": {
      id: "iss-eng-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
      priority: 1,
      assignee: null,
      createdAt: "2026-04-18T12:00:00.000Z",
      updatedAt: "2026-04-20T12:00:00.000Z",
    },
    // ENG-101 — priority 2, unassigned, fresh: also unassigned-priority.
    "/linear/issues/ENG-101.json": {
      id: "iss-eng-101",
      identifier: "ENG-101",
      title: "Add metrics dashboard",
      state: { type: "unstarted", name: "Todo" },
      priority: "2",
      assignee: null,
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:00.000Z",
    },
    // ENG-200 — assigned, low priority, very old + no recent comment: stale-no-activity.
    "/linear/issues/ENG-200.json": {
      id: "iss-eng-200",
      identifier: "ENG-200",
      title: "Migrate legacy worker pool",
      state: { type: "started", name: "In Progress" },
      priority: 3,
      assignee: { id: "user-1", name: "Alice" },
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-04-01T12:00:00.000Z",
    },
    // CS-77 — assigned, body mentions enterprise: customer-mentioned.
    "/linear/issues/CS-77.json": {
      id: "iss-cs-77",
      identifier: "CS-77",
      title: "Customer reports 500s after deploy",
      state: { type: "started", name: "In Progress" },
      priority: 3,
      assignee: { id: "user-2", name: "Bob" },
      description: "Reported by an enterprise account during the morning sync.",
      createdAt: "2026-04-15T12:00:00.000Z",
      updatedAt: "2026-04-20T12:00:00.000Z",
    },
    // ENG-300 — closed: should be filtered out of `all`.
    "/linear/issues/ENG-300.json": {
      id: "iss-eng-300",
      identifier: "ENG-300",
      title: "Closed issue",
      state: { type: "completed", name: "Done" },
      priority: 1,
      assignee: { id: "user-1", name: "Alice" },
      completedAt: "2026-04-15T12:00:00.000Z",
      updatedAt: "2026-04-15T12:00:00.000Z",
    },
    // Comments — recent comment on ENG-200 would mask staleness, so leave only an old one.
    "/linear/comments/c1.json": {
      id: "c1",
      issue: { id: "iss-eng-200" },
      body: "Old check-in.",
      updatedAt: "2026-03-15T12:00:00.000Z",
      createdAt: "2026-03-15T12:00:00.000Z",
    },
    // Recent comment on CS-77 — should NOT make CS-77 stale.
    "/linear/comments/c2.json": {
      id: "c2",
      issue: { id: "iss-cs-77" },
      body: "Confirmed mitigation.",
      updatedAt: "2026-04-20T12:00:00.000Z",
      createdAt: "2026-04-20T12:00:00.000Z",
    },
  };
}

function issueAndCommentFixturesWithAliases(): JsonFixtureMap {
  return {
    ...issueAndCommentFixtures(),
    "/linear/issues/by-title/login-fails-for-sso-users.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
    "/linear/issues/by-id/ENG-100.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
    "/linear/issues/by-state/started/ENG-100.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
  };
}

function issueAliasOnlyFixtures(): JsonFixtureMap {
  return {
    "/linear/issues/by-title/login-fails-for-sso-users.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
    "/linear/issues/by-id/ENG-100.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
    "/linear/issues/by-state/started/ENG-100.json": {
      __id: "ENG-100",
      identifier: "ENG-100",
      title: "Login fails for SSO users",
      state: { type: "started", name: "In Progress" },
    },
  };
}

interface HarnessOptions {
  env?: Record<string, unknown>;
  missingTreePaths?: string[];
  outputFile?: { content: string; semantics: FileSemantics } | null;
}

interface Harness {
  context: CatalogingContext<Record<string, unknown>>;
  relayfile: ReturnType<typeof createFakeRelayFileClient>;
  setOutputFile(file: { content: string; semantics: FileSemantics } | null): void;
}

function createHarness(fixtures: JsonFixtureMap, options: HarnessOptions = {}): Harness {
  const state: { outputFile: { content: string; semantics: FileSemantics } | null } = {
    outputFile: options.outputFile ?? null,
  };
  const relayfile = createFakeRelayFileClient(fixtures, state, options);
  const context = {
    workspaceId: WORKSPACE_ID,
    domain: "linear",
    relayfile,
    relayfileUrl: "https://relayfile.test",
    relayfileToken: "relayfile-token",
    env: options.env ?? {},
    now: NOW,
  } as unknown as CatalogingContext<Record<string, unknown>>;

  return {
    context,
    relayfile,
    setOutputFile(file) {
      state.outputFile = file;
    },
  };
}

function createFakeRelayFileClient(
  fixtures: JsonFixtureMap,
  state: { outputFile: { content: string; semantics: FileSemantics } | null },
  options: Pick<HarnessOptions, "missingTreePaths"> = {},
) {
  const missingTreePaths = new Set(options.missingTreePaths ?? []);
  const listTree = createTrackedAsyncFn(
    async (_workspaceId: string, options?: { path?: string }): Promise<TreeResponse> => {
      const path = options?.path ?? "/";
      if (missingTreePaths.has(path)) {
        throw new RelayFileApiError(404, { code: "not_found", message: "not found" });
      }
      const entries = Object.keys(fixtures)
        .filter((fixturePath) => fixturePath.startsWith(`${path}/`))
        .map(
          (fixturePath, index): TreeEntry => ({
            path: fixturePath,
            type: "file",
            revision: String(index + 1),
          }),
        );
      return { path, entries, nextCursor: null };
    },
  );

  const readFile = createTrackedAsyncFn(
    async (_workspaceId: string, path: string): Promise<FileReadResponse> => {
      if (path === OUTPUT_PATH) {
        if (!state.outputFile) {
          throw new RelayFileApiError(404, { code: "not_found", message: "not found" });
        }
        return {
          path,
          revision: "1",
          contentType: "application/json",
          encoding: "utf-8",
          content: state.outputFile.content,
          semantics: state.outputFile.semantics,
        };
      }
      const fixture = fixtures[path];
      if (!fixture) {
        throw new RelayFileApiError(404, { code: "not_found", message: "not found" });
      }
      return {
        path,
        revision: "1",
        contentType: "application/json",
        encoding: "utf-8",
        content: JSON.stringify(fixture),
      };
    },
  );

  return { listTree, readFile };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function stubFetch(implementation: typeof fetch): TrackedAsyncFn<Parameters<typeof fetch>, Response> {
  const calls: Parameters<typeof fetch>[] = [];
  const tracked = (async (...args: Parameters<typeof fetch>) => {
    calls.push(args);
    return implementation(...args);
  }) as TrackedAsyncFn<Parameters<typeof fetch>, Response>;
  tracked.calls = calls;
  globalThis.fetch = tracked as typeof fetch;
  return tracked;
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  try {
    assertMatchesSubset(actual, expected);
    return true;
  } catch {
    return false;
  }
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
