// Locks in the canonical-path reader behavior added in cloud#533 review
// follow-up. The writer side switched to `@relayfile/adapter-github/path-mapper`
// helpers in cloud#526 (sync) and cloud#533 (forward webhooks); the readers
// in `packages/web/lib/integrations/github-relayfile.ts` previously indexed
// the legacy `pulls/<n>/metadata.json` and `pulls/<n>/reviews/<id>.json`
// layout, so after either pipeline wrote a record, calls from the GitHub
// integrations UI (`packages/web/app/integrations/github/page.tsx`) returned
// empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubByIdAliasPath,
  githubIssuePath,
  githubNumberSlug,
  githubPullRequestPath,
  githubRepoIssuesIndexPath,
  githubRepoPullsIndexPath,
  githubReposIndexPath,
  githubReviewPath,
} from "@relayfile/adapter-github/path-mapper";

const { listTreeMock, readFileMock } = vi.hoisted(() => ({
  listTreeMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: class {
    listTree = listTreeMock;
    readFile = readFileMock;
  },
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintRelayfileToken: vi.fn().mockResolvedValue("test-token"),
}));

// `packages/web/lib/relayfile.ts:resolveRelayfileConfig` throws when its env
// vars are missing. `Resource` from `sst` is unavailable in tests, so feed
// the env-var path it already supports rather than mocking the module (a
// mock by alias path was not intercepting the in-module relative import).
process.env.RELAYFILE_URL = "http://relayfile.test";
process.env.RELAYAUTH_URL = "http://relayauth.test";
process.env.RELAYAUTH_API_KEY = "test-key";

const WORKSPACE_ID = "ws-test";
const OWNER = "agent-relay";
const REPO = "cloud";
const REPO_ROOT = `/github/repos/${OWNER}/${REPO}`;

function treeEntry(path: string): { type: "file"; path: string } {
  return { type: "file", path };
}

function fileBody<T>(value: T): { content: string; contentType: string } {
  return { content: JSON.stringify(value), contentType: "application/json" };
}

async function importReaders(): Promise<
  typeof import("../packages/web/lib/integrations/github-relayfile")
> {
  return import("../packages/web/lib/integrations/github-relayfile");
}

beforeEach(() => {
  listTreeMock.mockReset();
  readFileMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listRepos", () => {
  it("reads the canonical repos index instead of walking repo directories", async () => {
    readFileMock.mockResolvedValue(fileBody([
      {
        id: `${OWNER}/${REPO}`,
        title: `${OWNER}/${REPO}`,
        updated: "2026-05-12T09:00:00Z",
      },
    ]));

    const { listRepos } = await importReaders();
    const repos = await listRepos(WORKSPACE_ID);

    expect(repos).toEqual([{ owner: OWNER, repo: REPO }]);
    expect(readFileMock).toHaveBeenCalledWith(WORKSPACE_ID, githubReposIndexPath());
    expect(listTreeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["404", { status: 404 }],
    ["ENOENT", { code: "ENOENT" }],
  ])("returns [] when the repos index is missing with %s", async (_label, error) => {
    readFileMock.mockRejectedValue(error);

    const { listRepos } = await importReaders();
    const repos = await listRepos(WORKSPACE_ID);

    expect(repos).toEqual([]);
    expect(readFileMock).toHaveBeenCalledWith(WORKSPACE_ID, githubReposIndexPath());
    expect(listTreeMock).not.toHaveBeenCalled();
  });
});

describe("listPullRequests", () => {
  it("reads the canonical repo pulls index instead of walking PR directories", async () => {
    readFileMock.mockResolvedValue(fileBody([
      {
        id: "42",
        title: "Fix the thing",
        updated: "2026-05-12T09:00:00Z",
        number: 42,
        state: "open",
      },
      {
        id: "40",
        title: "40",
        updated: "2026-05-12T08:00:00Z",
        number: 40,
        state: "closed",
      },
    ]));

    const { listPullRequests } = await importReaders();
    const result = await listPullRequests(WORKSPACE_ID, OWNER, REPO);

    expect(result).toEqual([
      { number: 42, title: "Fix the thing", state: "open" },
      { number: 40, title: "40", state: "closed" },
    ]);
    expect(readFileMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      githubRepoPullsIndexPath(OWNER, REPO),
    );
    expect(listTreeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["404", { status: 404 }],
    ["ENOENT", { code: "ENOENT" }],
  ])("returns [] when the pulls index is missing with %s", async (_label, error) => {
    readFileMock.mockRejectedValue(error);

    const { listPullRequests } = await importReaders();
    const pullRequests = await listPullRequests(WORKSPACE_ID, OWNER, REPO);

    expect(pullRequests).toEqual([]);
    expect(readFileMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      githubRepoPullsIndexPath(OWNER, REPO),
    );
    expect(listTreeMock).not.toHaveBeenCalled();
  });
});

describe("getPullRequest", () => {
  it("reads a PR number from the v2 by-id alias", async () => {
    readFileMock.mockResolvedValue(fileBody({ number: 42, title: "Fix the thing" }));

    const { getPullRequest } = await importReaders();
    const pr = await getPullRequest(WORKSPACE_ID, OWNER, REPO, 42);

    expect(pr?.number).toBe(42);
    expect(readFileMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      githubByIdAliasPath(OWNER, REPO, "pulls", 42),
    );
    expect(listTreeMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy `<n>/metadata.json` when the v2 alias is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readFileMock
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce(fileBody({ number: 42, title: "Fix the thing" }));

    const { getPullRequest } = await importReaders();
    const pr = await getPullRequest(WORKSPACE_ID, OWNER, REPO, 42);

    expect(pr?.number).toBe(42);
    expect(readFileMock).toHaveBeenNthCalledWith(
      1,
      WORKSPACE_ID,
      githubByIdAliasPath(OWNER, REPO, "pulls", 42),
    );
    expect(readFileMock).toHaveBeenNthCalledWith(
      2,
      WORKSPACE_ID,
      `${REPO_ROOT}/pulls/42/metadata.json`,
    );
    expect(warn).toHaveBeenCalledWith(
      "[github-relayfile] falling back to legacy pull request metadata path",
      expect.objectContaining({
        number: 42,
      }),
    );
  });

  it("returns null when neither v2 nor legacy PR metadata exists", async () => {
    readFileMock
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce({ status: 404 });

    const { getPullRequest } = await importReaders();
    const pr = await getPullRequest(WORKSPACE_ID, OWNER, REPO, 42);

    expect(pr).toBeNull();
  });
});

describe("listIssues", () => {
  it("reads the canonical repo issues index instead of walking issue directories", async () => {
    readFileMock.mockResolvedValue(fileBody([
      {
        id: "7",
        title: "Bug",
        updated: "2026-05-12T09:00:00Z",
        number: 7,
        state: "open",
      },
    ]));

    const { listIssues } = await importReaders();
    const result = await listIssues(WORKSPACE_ID, OWNER, REPO);

    expect(result).toEqual([{ number: 7, title: "Bug", state: "open" }]);
    expect(readFileMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      githubRepoIssuesIndexPath(OWNER, REPO),
    );
    expect(listTreeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["404", { status: 404 }],
    ["ENOENT", { code: "ENOENT" }],
  ])("returns [] when the issues index is missing with %s", async (_label, error) => {
    readFileMock.mockRejectedValue(error);

    const { listIssues } = await importReaders();
    const issues = await listIssues(WORKSPACE_ID, OWNER, REPO);

    expect(issues).toEqual([]);
    expect(readFileMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      githubRepoIssuesIndexPath(OWNER, REPO),
    );
    expect(listTreeMock).not.toHaveBeenCalled();
  });
});

describe("getReviews", () => {
  it("filters flat `reviews/<id>.json` entries by `pull_request_url` for the requested PR", async () => {
    const apiHost = "https://api.github.com";
    const reviewForPr42 = `${REPO_ROOT}/reviews/100.json`;
    const otherReviewForPr42 = `${REPO_ROOT}/reviews/101.json`;
    const reviewForPr99 = `${REPO_ROOT}/reviews/200.json`;

    listTreeMock.mockResolvedValue({
      entries: [
        treeEntry(reviewForPr42),
        treeEntry(otherReviewForPr42),
        treeEntry(reviewForPr99),
      ],
    });
    readFileMock.mockImplementation(async (_ws: string, path: string) => {
      if (path === reviewForPr42) {
        return fileBody({
          id: 100,
          state: "approved",
          submitted_at: "2026-05-12T09:00:00Z",
          pull_request_url: `${apiHost}/repos/${OWNER}/${REPO}/pulls/42`,
        });
      }
      if (path === otherReviewForPr42) {
        return fileBody({
          id: 101,
          state: "commented",
          submitted_at: "2026-05-12T10:00:00Z",
          pull_request_url: `${apiHost}/repos/${OWNER}/${REPO}/pulls/42`,
        });
      }
      if (path === reviewForPr99) {
        return fileBody({
          id: 200,
          state: "approved",
          submitted_at: "2026-05-12T11:00:00Z",
          pull_request_url: `${apiHost}/repos/${OWNER}/${REPO}/pulls/99`,
        });
      }
      throw new Error(`unexpected read: ${path}`);
    });

    const { getReviews } = await importReaders();
    const reviews = await getReviews(WORKSPACE_ID, OWNER, REPO, 42);
    const expectedReviewsDir = githubReviewPath(OWNER, REPO, 100).replace(/\/100\.json$/, "");

    expect(reviews.map((r) => r.id)).toEqual([101, 100]);
    expect(listTreeMock).toHaveBeenCalledWith(WORKSPACE_ID, {
      path: expectedReviewsDir,
      depth: 1,
    });
  });

  it("does not match PR numbers that share a numeric prefix", async () => {
    listTreeMock.mockResolvedValue({
      entries: [treeEntry(`${REPO_ROOT}/reviews/100.json`)],
    });
    readFileMock.mockResolvedValue(
      fileBody({
        id: 100,
        pull_request_url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/420`,
      }),
    );

    const { getReviews } = await importReaders();
    const reviews = await getReviews(WORKSPACE_ID, OWNER, REPO, 42);

    expect(reviews).toEqual([]);
  });
});

describe("computePath", () => {
  it("matches adapter helpers for titled and title-less webhook records", async () => {
    const { computePath, normalizeWebhook } = await importReaders();

    const titledPull = normalizeWebhook({
      headers: { "x-github-event": "pull_request" },
      connectionId: "conn-test",
      payload: {
        action: "opened",
        repository: {
          owner: { login: OWNER },
          name: REPO,
        },
        pull_request: {
          number: 526,
          title: "Emit Relayfile file-native adapter artifacts",
        },
      },
    });
    expect(computePath(titledPull)).toBe(
      githubPullRequestPath(
        OWNER,
        REPO,
        "526",
        "Emit Relayfile file-native adapter artifacts",
      ),
    );

    const titlelessIssue = normalizeWebhook({
      headers: { "x-github-event": "issues" },
      connectionId: "conn-test",
      payload: {
        action: "opened",
        repository: {
          owner: { login: OWNER },
          name: REPO,
        },
        issue: {
          number: 527,
        },
      },
    });
    expect(computePath(titlelessIssue)).toBe(
      githubIssuePath(OWNER, REPO, 527, undefined),
    );

    const issueComment = normalizeWebhook({
      headers: { "x-github-event": "issue_comment" },
      connectionId: "conn-test",
      payload: {
        action: "created",
        repository: {
          owner: { login: OWNER },
          name: REPO,
        },
        issue: {
          number: 528,
          title: "Webhook comment path",
        },
        comment: {
          id: 123456,
        },
      },
    });
    expect(computePath(issueComment)).toBe(
      `${REPO_ROOT}/issues/${githubNumberSlug(528, "Webhook comment path")}/comments/123456.json`,
    );
  });
});
