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

import { activePrsInsight } from "../src/insights/active-prs.js";

const WORKSPACE_ID = "workspace_123";
const NOW = new Date("2026-04-21T12:00:00.000Z");
const OUTPUT_PATH = "/insights/github/active-prs.json";
const SIGNAL_FINGERPRINT_PROPERTY = "cataloging.signalFingerprint";

interface ActivePrsContent {
  generatedAt: string;
  summary: string;
  highlights: Array<{ kind: string; headline: string; prs: Array<Record<string, unknown>> }>;
  metrics: { openCount: number; draftCount: number; p50AgeDays: number; p90AgeDays: number };
  all: Array<Record<string, unknown> & { number: number }>;
}

interface InsightWritePayload {
  content: ActivePrsContent;
  contentType: string;
  semantics?: FileSemantics;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("activePrsInsight", () => {
  it("returns an empty insight when no repos are present", async () => {
    const { context } = createHarness({});

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(output.content.all, []);
    assert.deepEqual(output.content.highlights, []);
    assert.deepEqual(output.content.metrics, {
      openCount: 0,
      draftCount: 0,
      p50AgeDays: 0,
      p90AgeDays: 0,
    });
    assert.match(output.content.summary, /See highlights for details/);
  });

  it("returns the empty state when the repos tree returns 404", async () => {
    const { context } = createHarness({}, { missingTreePaths: ["/github/repos"] });

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(output.content.all, []);
    assert.deepEqual(output.content.highlights, []);
    assert.deepEqual(output.content.metrics, {
      openCount: 0,
      draftCount: 0,
      p50AgeDays: 0,
      p90AgeDays: 0,
    });
  });

  it("includes only open pull requests in the flat `all` list", async () => {
    const { context } = createHarness(prFixtures());

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(
      output.content.all
        .map((pr) => pr.number)
        .slice()
        .sort((a, b) => a - b),
      [17, 19, 20, 22],
    );
  });

  it("emits the redesigned insight shape with bucketed highlights and metrics", async () => {
    const { context, relayfile } = createHarness(prFixtures());

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.ok(
      relayfile.listTree.calls.some(
        ([workspaceId, options]) =>
          workspaceId === WORKSPACE_ID &&
          matchesSubset(options, {
            path: "/github/repos",
            depth: 2,
            correlationId: "insight:active-prs:repos",
          }),
      ),
    );

    assert.equal(output.contentType, "application/json");
    assert.match(
      String(output.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY]),
      /^sha256:/,
    );
    assert.equal(output.content.generatedAt, NOW.toISOString());
    assert.equal(typeof output.content.summary, "string");
    assert.ok(output.content.summary.length > 0);

    assert.deepEqual(Object.keys(output.content.all[0] ?? {}).sort(), [
      "author",
      "draft",
      "number",
      "repo",
      "requestedReviewers",
      "title",
      "updatedAt",
    ]);

    const highlightsByKind = Object.fromEntries(output.content.highlights.map((h) => [h.kind, h]));

    const blockedOnReview = highlightsByKind["blocked-on-review"];
    assert.ok(blockedOnReview);
    assert.ok(
      blockedOnReview.prs.some((pr) =>
        matchesSubset(pr, { number: 17, repo: "acme/platform", reviewer: "bob", waitingDays: 5 }),
      ),
      "expected PR 17 blocked-on-review highlight",
    );

    const ciFailing = highlightsByKind["ci-failing"];
    assert.ok(ciFailing);
    assert.ok(
      ciFailing.prs.some((pr) =>
        matchesSubset(pr, { number: 19, repo: "acme/worker", checkName: "ci/build" }),
      ),
      "expected PR 19 ci-failing highlight",
    );

    const staleDraft = highlightsByKind["stale-draft"];
    assert.ok(staleDraft);
    assert.ok(
      staleDraft.prs.some((pr) =>
        matchesSubset(pr, { number: 20, repo: "acme/platform", ageDays: 14 }),
      ),
      "expected PR 20 stale-draft highlight",
    );

    const mergeConflict = highlightsByKind["merge-conflict"];
    assert.ok(mergeConflict);
    assert.ok(
      mergeConflict.prs.some((pr) => matchesSubset(pr, { number: 22, repo: "acme/worker" })),
      "expected PR 22 merge-conflict highlight",
    );

    assert.equal(output.content.metrics.openCount, 4);
    assert.equal(output.content.metrics.draftCount, 1);
  });

  it("does NOT emit a blocked-on-review highlight when an approved review covers the current head", async () => {
    const fixtures = prFixtures();
    fixtures["/github/repos/acme/platform/reviews/901.json"] = {
      state: "approved",
      pullNumber: 17,
      headSha: "sha-17",
    };
    const { context } = createHarness(fixtures);

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;
    const kinds = output.content.highlights.map((h) => h.kind);
    assert.ok(!kinds.includes("blocked-on-review"));
  });

  it("still emits blocked-on-review when an approval targets a stale head SHA", async () => {
    const fixtures = prFixtures();
    fixtures["/github/repos/acme/platform/reviews/901.json"] = {
      state: "approved",
      pullNumber: 17,
      headSha: "sha-17-old",
    };
    const { context } = createHarness(fixtures);

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;
    const kinds = output.content.highlights.map((h) => h.kind);
    assert.ok(kinds.includes("blocked-on-review"));
  });

  it("uses the cached summary on a second invocation with identical inputs (LLM called once)", async () => {
    const fetchMock = stubFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Cached summary text from LLM." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const harness = createHarness(prFixtures(), { env: { OPENROUTER_API_KEY: "key_test" } });

    const first = (await activePrsInsight.generate(harness.context)) as InsightWritePayload;
    assert.equal(first.content.summary, "Cached summary text from LLM.");
    assert.equal(fetchMock.calls.length, 1);
    const fingerprint = first.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY];
    assert.ok(fingerprint);

    // Simulate the writer persisting the first run; the second run should
    // observe the existing file and reuse its summary instead of calling fetch.
    harness.setOutputFile({
      content: JSON.stringify(first.content),
      semantics: { properties: { [SIGNAL_FINGERPRINT_PROPERTY]: fingerprint } },
    });

    const second = (await activePrsInsight.generate(harness.context)) as InsightWritePayload;
    assert.equal(second.content.summary, "Cached summary text from LLM.");
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(second.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY], fingerprint);
  });

  it("does not treat repo aliases or PR alias mirrors as additional open pull requests", async () => {
    const { context } = createHarness(prFixturesWithAliases());

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.equal(output.content.metrics.openCount, 4);
    assert.equal(output.content.metrics.draftCount, 1);
    assert.deepEqual(
      output.content.highlights
        .flatMap((highlight) => highlight.prs)
        .map((pr) => pr.number)
        .slice()
        .sort((a, b) => a - b),
      [17, 19, 20, 22],
    );
  });

  it("skips malformed open pull request files that are missing the canonical number", async () => {
    const fixtures = prFixtures();
    fixtures["/github/repos/acme/platform/pulls/missing-number.json"] = {
      state: "open",
      title: "Missing number should be ignored",
      user: { login: "zoe" },
      updated_at: "2026-04-20T12:00:00.000Z",
      base: { repo: { full_name: "acme/platform" } },
    };
    const { context } = createHarness(fixtures);

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(
      output.content.all
        .map((pr) => pr.number)
        .slice()
        .sort((a, b) => a - b),
      [17, 19, 20, 22],
    );
    assert.equal(output.content.metrics.openCount, 4);
  });

  it("returns the empty state when only repo and pull-request alias trees are present", async () => {
    const { context } = createHarness(prAliasOnlyFixtures());

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(output.content.all, []);
    assert.deepEqual(output.content.highlights, []);
    assert.deepEqual(output.content.metrics, {
      openCount: 0,
      draftCount: 0,
      p50AgeDays: 0,
      p90AgeDays: 0,
    });
  });

  it("ignores closed pull-request alias files mirrored under by-id", async () => {
    const fixtures = prFixturesWithAliases();
    fixtures["/github/repos/acme/platform/pulls/by-id/18.json"] = {
      state: "closed",
      number: 18,
      base: { repo: { full_name: "acme/platform" } },
      title: "Closed alias mirror",
      user: { login: "dan" },
      updated_at: "2026-04-20T12:00:00.000Z",
    };
    const { context } = createHarness(fixtures);

    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(
      output.content.all
        .map((pr) => pr.number)
        .slice()
        .sort((a, b) => a - b),
      [17, 19, 20, 22],
    );
    assert.equal(output.content.metrics.openCount, 4);
  });

  it("does not hide canonical repos whose owner or repo name happens to match alias keywords", async () => {
    // Regression for the broad alias-segment match: a real repo whose
    // owner or repo name is `by-id`/`by-title` must still surface.
    // The reserved alias keyword `by-name` is only excluded at the
    // `/github/repos/<segment>/...` position.
    const fixtures: JsonFixtureMap = {
      "/github/repos/acme/by-id/pulls/17.json": {
        state: "open",
        number: 17,
        base: { repo: { full_name: "acme/by-id" } },
        title: "Sample PR in a repo literally named by-id",
        user: { login: "alice" },
        updated_at: "2026-04-19T12:00:00.000Z",
        draft: false,
        head: { sha: "sha-by-id-17" },
        mergeable: true,
      },
      "/github/repos/by-title/widget/pulls/22.json": {
        state: "open",
        number: 22,
        base: { repo: { full_name: "by-title/widget" } },
        title: "Owner literally named by-title",
        user: { login: "bob" },
        updated_at: "2026-04-19T12:00:00.000Z",
        draft: false,
        head: { sha: "sha-by-title-22" },
        mergeable: true,
      },
    };

    const { context } = createHarness(fixtures);
    const output = (await activePrsInsight.generate(context)) as InsightWritePayload;

    assert.deepEqual(
      output.content.all
        .map((pr) => pr.number)
        .slice()
        .sort((a, b) => a - b),
      [17, 22],
    );
  });
});

type JsonFixtureMap = Record<string, Record<string, unknown>>;

function prFixtures(): JsonFixtureMap {
  return {
    // PR 17: requested reviewers, no approved review, updated 5 days ago.
    "/github/repos/acme/platform/pulls/17.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
      created_at: "2026-04-15T12:00:00.000Z",
      draft: false,
      requested_reviewers: [{ login: "bob" }, { login: "carol" }],
      head: { sha: "sha-17" },
      mergeable: true,
    },
    // PR 18: closed → excluded.
    "/github/repos/acme/platform/pulls/18.json": {
      state: "closed",
      number: 18,
      title: "Closed PR",
      user: { login: "dan" },
      updated_at: "2026-04-20T12:00:00.000Z",
      base: { repo: { full_name: "acme/platform" } },
    },
    // PR 19: failing CI for ≥ 1 day.
    "/github/repos/acme/worker/pulls/19.json": {
      state: "open",
      number: 19,
      base: { repo: { full_name: "acme/worker" } },
      title: "Refresh worker fixtures",
      user: { login: "dina" },
      updated_at: "2026-04-19T16:45:00.000Z",
      draft: false,
      head: { sha: "sha-19" },
      mergeable: true,
    },
    // PR 20: stale draft for ≥ 7 days.
    "/github/repos/acme/platform/pulls/20.json": {
      state: "open",
      number: 20,
      base: { repo: { full_name: "acme/platform" } },
      title: "Long-running draft",
      user: { login: "erin" },
      updated_at: "2026-04-07T12:00:00.000Z",
      draft: true,
      head: { sha: "sha-20" },
      mergeable: true,
    },
    // PR 22: merge conflict (mergeable=false). Updated today so it doesn't trip review/draft buckets.
    "/github/repos/acme/worker/pulls/22.json": {
      state: "open",
      number: 22,
      base: { repo: { full_name: "acme/worker" } },
      title: "Conflicted change",
      user: { login: "fran" },
      updated_at: "2026-04-21T11:00:00.000Z",
      draft: false,
      head: { sha: "sha-22" },
      mergeable: false,
    },
    // Reviews — only PR 19 has an approved review (for ci-failing fixture, so blocked-on-review is suppressed
    // for it via age, but PR 17 still trips). Provide a stale review for 17 to exercise the signal-bucketing
    // path: state="changes_requested", which should NOT count as approved.
    "/github/repos/acme/platform/reviews/801.json": {
      state: "changes_requested",
      pullNumber: 17,
      headSha: "sha-17",
    },
    // Checks — failing check on PR 19 reported 2 days ago → ci-failing.
    "/github/repos/acme/worker/checks/901.json": {
      conclusion: "failure",
      name: "ci/build",
      pullNumber: 19,
      head_sha: "sha-19",
      completed_at: "2026-04-19T12:00:00.000Z",
    },
    // Successful check on PR 22 — should NOT push it into ci-failing.
    "/github/repos/acme/worker/checks/902.json": {
      conclusion: "success",
      name: "ci/build",
      pullNumber: 22,
      head_sha: "sha-22",
      completed_at: "2026-04-21T10:00:00.000Z",
    },
  };
}

function prFixturesWithAliases(): JsonFixtureMap {
  return {
    ...prFixtures(),
    "/github/repos/by-name/acme__platform/metadata.json": {
      full_name: "acme/platform",
      name: "platform",
      owner: { login: "acme" },
    },
    "/github/repos/acme/platform/pulls/by-title/add-cataloging-summaries.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
    },
    "/github/repos/acme/platform/pulls/by-id/17.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
    },
    "/github/repos/acme/platform/pulls/by-state/open/17.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
    },
  };
}

function prAliasOnlyFixtures(): JsonFixtureMap {
  return {
    "/github/repos/by-name/acme__platform/metadata.json": {
      full_name: "acme/platform",
      name: "platform",
      owner: { login: "acme" },
    },
    "/github/repos/acme/platform/pulls/by-title/add-cataloging-summaries.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
    },
    "/github/repos/acme/platform/pulls/by-id/17.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
    },
    "/github/repos/acme/platform/pulls/by-state/open/17.json": {
      state: "open",
      number: 17,
      base: { repo: { full_name: "acme/platform" } },
      title: "Add cataloging summaries",
      user: { login: "alice" },
      updated_at: "2026-04-16T12:00:00.000Z",
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
    domain: "github",
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
