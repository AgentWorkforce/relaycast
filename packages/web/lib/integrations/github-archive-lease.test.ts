import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_CODELOAD_TTL_MS,
  GithubArchiveLeaseError,
  mintGithubArchiveCodeloadUrl,
  resolveGithubRefToSha,
} from "./github-archive-lease";

const OWNER = "owner";
const REPO = "repo";
const HEAD_SHA = "abc";
const RESOLVED_SHA = "abc123def4567890abc123def4567890abc123de";
const INSTALLATION_TOKEN = "ghs_TEST_TOKEN_42";
const CODELOAD_URL =
  "https://codeload.github.com/owner/repo/legacy.tar.gz/abc?token=xyz";
const UPSTREAM_URL = "https://api.github.com/repos/owner/repo/tarball/abc";
const NOW_MS = 1_000_000;

async function expectGithubArchiveLeaseError(
  promise: Promise<unknown>,
  expected: {
    stage: GithubArchiveLeaseError["stage"];
    upstreamStatus?: number;
  },
) {
  await expect(promise).rejects.toMatchObject(expected);
  await expect(promise).rejects.toBeInstanceOf(GithubArchiveLeaseError);
}

function stubFetch(init: {
  status: number;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}) {
  return vi.fn(
    async (_input: RequestInfo | URL, _requestInit?: RequestInit) =>
      new Response(init.body ?? null, {
        status: init.status,
        headers: init.headers ?? {},
      }),
  );
}

describe("resolveGithubRefToSha", () => {
  it("returns the resolved sha from GitHub's sha media type response", async () => {
    const fetchImpl = stubFetch({
      status: 200,
      body: ` ${RESOLVED_SHA}\n`,
    });

    const result = await resolveGithubRefToSha({
      owner: OWNER,
      repo: REPO,
      ref: "HEAD",
      installationToken: INSTALLATION_TOKEN,
      fetchImpl,
    });

    expect(result).toBe(RESOLVED_SHA);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "https://api.github.com/repos/owner/repo/commits/HEAD",
    );
    expect(calledInit.method).toBe("GET");
    expect(calledInit.headers).toEqual({
      Authorization: `token ${INSTALLATION_TOKEN}`,
      "User-Agent": "AgentWorkforce-Cloud-Clone-Archive-Lease",
      Accept: "application/vnd.github.sha",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("throws GithubArchiveLeaseError when ref resolution returns non-2xx", async () => {
    const fetchImpl = stubFetch({ status: 404, body: "Not Found" });

    await expectGithubArchiveLeaseError(
      resolveGithubRefToSha({
        owner: OWNER,
        repo: REPO,
        ref: "refs/heads/main",
        installationToken: INSTALLATION_TOKEN,
        fetchImpl,
      }),
      {
        stage: "ref_resolve_failed",
        upstreamStatus: 404,
      },
    );
  });

  it("throws GithubArchiveLeaseError when ref resolution returns a non-sha body", async () => {
    const fetchImpl = stubFetch({ status: 200, body: "not-a-sha" });

    await expectGithubArchiveLeaseError(
      resolveGithubRefToSha({
        owner: OWNER,
        repo: REPO,
        ref: "HEAD",
        installationToken: INSTALLATION_TOKEN,
        fetchImpl,
      }),
      {
        stage: "ref_resolve_failed",
        upstreamStatus: 200,
      },
    );
  });
});

describe("mintGithubArchiveCodeloadUrl", () => {
  it("returns { url, expiresAt, sha } on a 302 codeload redirect", async () => {
    const fetchImpl = stubFetch({
      status: 302,
      headers: { Location: CODELOAD_URL },
    });

    const result = await mintGithubArchiveCodeloadUrl({
      owner: OWNER,
      repo: REPO,
      headSha: HEAD_SHA,
      installationToken: INSTALLATION_TOKEN,
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(result.url).toBe(CODELOAD_URL);
    expect(result.sha).toBe(HEAD_SHA);
    expect(result.expiresAt).toBe(
      new Date(NOW_MS + GITHUB_CODELOAD_TTL_MS).toISOString(),
    );
  });

  it("throws GithubArchiveLeaseError when upstream returns 200 (no redirect)", async () => {
    const fetchImpl = stubFetch({ status: 200 });

    await expectGithubArchiveLeaseError(
      mintGithubArchiveCodeloadUrl({
        owner: OWNER,
        repo: REPO,
        headSha: HEAD_SHA,
        installationToken: INSTALLATION_TOKEN,
        fetchImpl,
        nowMs: NOW_MS,
      }),
      {
        stage: "github_tarball_redirect",
        upstreamStatus: 200,
      },
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", { Location: "" }],
  ] as const)(
    "throws when upstream is 302 but Location header is %s",
    async (_caseName, headers) => {
      const fetchImpl = stubFetch({ status: 302, headers });

      await expectGithubArchiveLeaseError(
        mintGithubArchiveCodeloadUrl({
          owner: OWNER,
          repo: REPO,
          headSha: HEAD_SHA,
          installationToken: INSTALLATION_TOKEN,
          fetchImpl,
          nowMs: NOW_MS,
        }),
        {
          stage: "github_tarball_redirect",
          upstreamStatus: 302,
        },
      );
    },
  );

  it("throws when upstream is 302 but Location is not a codeload URL", async () => {
    const fetchImpl = stubFetch({
      status: 302,
      headers: {
        Location:
          "https://evil.example.com/owner/repo/legacy.tar.gz?token=xyz",
      },
    });

    await expectGithubArchiveLeaseError(
      mintGithubArchiveCodeloadUrl({
        owner: OWNER,
        repo: REPO,
        headSha: HEAD_SHA,
        installationToken: INSTALLATION_TOKEN,
        fetchImpl,
        nowMs: NOW_MS,
      }),
      {
        stage: "github_tarball_redirect",
        upstreamStatus: 302,
      },
    );
  });

  it("passes Authorization: token <installationToken> and required headers", async () => {
    const fetchImpl = stubFetch({
      status: 302,
      headers: { Location: CODELOAD_URL },
    });

    await mintGithubArchiveCodeloadUrl({
      owner: OWNER,
      repo: REPO,
      headSha: HEAD_SHA,
      installationToken: INSTALLATION_TOKEN,
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(UPSTREAM_URL);
    expect(calledInit.method).toBe("GET");
    expect(calledInit.redirect).toBe("manual");
    expect(calledInit.headers).toEqual({
      Authorization: `token ${INSTALLATION_TOKEN}`,
      "User-Agent": "AgentWorkforce-Cloud-Clone-Archive-Lease",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("does not include the installation token in the returned URL", async () => {
    const fetchImpl = stubFetch({
      status: 302,
      headers: { Location: CODELOAD_URL },
    });

    const result = await mintGithubArchiveCodeloadUrl({
      owner: OWNER,
      repo: REPO,
      headSha: HEAD_SHA,
      installationToken: INSTALLATION_TOKEN,
      fetchImpl,
      nowMs: NOW_MS,
    });

    expect(result.url).toBe(CODELOAD_URL);
    expect(JSON.stringify(result)).not.toContain(INSTALLATION_TOKEN);
  });
});
