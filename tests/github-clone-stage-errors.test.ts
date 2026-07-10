import { describe, expect, test, vi } from "vitest";
import { Readable } from "node:stream";

import {
  importGithubTarballByRelayfileFetch,
  importGithubTarballToRelayfile,
} from "../packages/core/src/clone/github-clone-tar-importer";

describe("github clone stage errors", () => {
  test("labels Relayfile import fetch failures before they reach job status", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      importGithubTarballToRelayfile({
        relayfileUrl: "https://relayfile.example",
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        headSha: "abc123",
        jobId: "job-1",
        archive: Readable.from(["archive"]),
        token: async () => "relay-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      stage: "relayfile_tar_import_fetch_failed",
      message: "relayfile_tar_import_fetch_failed: fetch failed",
    });
  });

  test("labels Relayfile import HTTP failures with status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("busy", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    await expect(
      importGithubTarballToRelayfile({
        relayfileUrl: "https://relayfile.example",
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        headSha: "abc123",
        jobId: "job-1",
        archive: Readable.from(["archive"]),
        token: async () => "relay-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      stage: "relayfile_tar_import_failed",
      status: 503,
      message:
        "relayfile_tar_import_failed: Relayfile GitHub tarball import failed (503 Service Unavailable): busy",
    });
  });

  test("labels malformed Relayfile import responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        statusText: "OK",
      }),
    );

    await expect(
      importGithubTarballToRelayfile({
        relayfileUrl: "https://relayfile.example",
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        headSha: "abc123",
        jobId: "job-1",
        archive: Readable.from(["archive"]),
        token: async () => "relay-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      stage: "relayfile_tar_import_failed",
    });
  });

  test("starts and polls Relayfile-fetch imports without streaming the archive through the clone worker", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1", status: "queued" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1", status: "importing" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-1",
            status: "completed",
            imported: 3,
            errorCount: 0,
            errors: [],
            skipped: [],
            bytesWritten: 12,
          }),
          { status: 200 },
        ),
      );

    const result = await importGithubTarballByRelayfileFetch({
      relayfileUrl: "https://relayfile.example",
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "HEAD",
      headSha: "abc123",
      jobId: "job-1",
      tarballUrl: "https://api.github.com/repos/octo/hello-world/tarball/HEAD",
      githubToken: "github-token",
      token: async () => "relay-token",
      fetchImpl,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      imported: 3,
      errorCount: 0,
      bytesWritten: 12,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const startInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(fetchImpl.mock.calls[0]?.[0]?.toString()).toContain(
      "/fs/import/github-tarball/fetch",
    );
    expect(startInit.headers).toMatchObject({
      Authorization: "Bearer relay-token",
      "X-GitHub-Token": "github-token",
    });
    expect(startInit.body).toBe(
      JSON.stringify({
        owner: "octo",
        repo: "hello-world",
        ref: "HEAD",
        headSha: "abc123",
        jobId: "job-1",
        tarballUrl:
          "https://api.github.com/repos/octo/hello-world/tarball/HEAD",
      }),
    );
  });

  test("keeps polling Relayfile-fetch import jobs through transient status fetch failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1", status: "queued" }), { status: 202 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-1",
            status: "completed",
            imported: 3,
            errorCount: 0,
            errors: [],
            skipped: [],
            bytesWritten: 12,
          }),
          { status: 200 },
        ),
      );

    const result = await importGithubTarballByRelayfileFetch({
      relayfileUrl: "https://relayfile.example",
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "HEAD",
      headSha: "abc123",
      jobId: "job-1",
      tarballUrl: "https://api.github.com/repos/octo/hello-world/tarball/HEAD",
      githubToken: "github-token",
      token: async () => "relay-token",
      fetchImpl,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      imported: 3,
      errorCount: 0,
      bytesWritten: 12,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1]?.[0]?.toString()).toContain(
      "/fs/import/github-tarball/jobs/job-1",
    );
    expect(fetchImpl.mock.calls[2]?.[0]?.toString()).toContain(
      "/fs/import/github-tarball/jobs/job-1",
    );
  });
});
