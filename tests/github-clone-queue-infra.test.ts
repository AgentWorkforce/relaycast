import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const githubCloneQueueInfra = readFileSync(
  new URL("../infra/github-clone-queue.ts", import.meta.url),
  "utf8",
);

function cloneWorkerSubscribeBlock(): string {
  const subscribeStart = githubCloneQueueInfra.indexOf("GithubCloneQueue.subscribe(");
  expect(subscribeStart).toBeGreaterThanOrEqual(0);

  const subscribeEnd = githubCloneQueueInfra.indexOf(");", subscribeStart);
  expect(subscribeEnd).toBeGreaterThan(subscribeStart);

  return githubCloneQueueInfra.slice(subscribeStart, subscribeEnd);
}

describe("GithubCloneQueue subscriber infra", () => {
  it("injects the cloud app URL for local archive materialization", () => {
    expect(githubCloneQueueInfra).toEqual(
      expect.stringContaining('import { appUrl } from "./web-routing";'),
    );

    const subscribeBlock = cloneWorkerSubscribeBlock();

    expect(subscribeBlock).toEqual(
      expect.stringContaining("CLOUD_API_URL: appUrl"),
    );
  });
});
