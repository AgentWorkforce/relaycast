import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNangoClient: vi.fn(),
  proxy: vi.fn(),
}));

vi.mock("./nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
}));

import { nangoGithubTarball } from "./github-nango-proxy-client";

describe("nangoGithubTarball", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getNangoClient.mockReturnValue({ proxy: mocks.proxy });
    mocks.proxy
      .mockResolvedValueOnce({
        data: {
          default_branch: "main",
        },
      })
      .mockResolvedValueOnce({
        data: {
          sha: "587be9d8ce0ffed5202ea773134a993035244c84",
        },
      })
      .mockResolvedValueOnce({
        data: Readable.from(["tarball"]),
        headers: {
          "content-length": "7",
        },
      });
  });

  it("requests GitHub tarballs through Nango with a GitHub API media Accept header", async () => {
    const result = await nangoGithubTarball({
      connectionId: "conn-github",
      providerConfigKey: "github-relay",
      owner: "AgentWorkforce",
      repo: "cloud",
      ref: "HEAD",
    });

    expect(result.headSha).toBe("587be9d8ce0ffed5202ea773134a993035244c84");
    expect(result.contentLength).toBe(7);
    expect(mocks.proxy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "GET",
        endpoint:
          "/repos/AgentWorkforce/cloud/tarball/587be9d8ce0ffed5202ea773134a993035244c84",
        connectionId: "conn-github",
        providerConfigKey: "github-relay",
        responseType: "stream",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
    expect(mocks.proxy.mock.calls[2]?.[0]?.headers).not.toEqual(
      expect.objectContaining({
        Accept: "application/x-gzip, application/octet-stream",
      }),
    );
  });
});
