import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowLaunchQueueInfra = readFileSync(
  new URL("../infra/workflow-launch-queue.ts", import.meta.url),
  "utf8",
);

function launchWorkerLinkBlock(): string {
  const subscribeStart = workflowLaunchQueueInfra.indexOf("WorkflowLaunchQueue.subscribe(");
  expect(subscribeStart).toBeGreaterThanOrEqual(0);

  const linkStart = workflowLaunchQueueInfra.indexOf("link: [", subscribeStart);
  expect(linkStart).toBeGreaterThanOrEqual(0);

  const linkEnd = workflowLaunchQueueInfra.indexOf("],", linkStart);
  expect(linkEnd).toBeGreaterThan(linkStart);

  return workflowLaunchQueueInfra.slice(linkStart, linkEnd);
}

describe("WorkflowLaunchQueue subscriber infra", () => {
  it("links every SST resource the launch worker reads at runtime", () => {
    const linkBlock = launchWorkerLinkBlock();

    expect(linkBlock).toEqual(expect.stringContaining("neonDatabaseUrl"));
    expect(linkBlock).toEqual(expect.stringContaining("brokerKeySecret"));
    expect(linkBlock).toEqual(expect.stringContaining("credentialEncryptionKey"));
    expect(linkBlock).toEqual(expect.stringContaining("credentialProxyJwtSecret"));
    expect(linkBlock).toEqual(expect.stringContaining("daytonaApiKey"));
    expect(linkBlock).toEqual(expect.stringContaining("nangoSecretKey"));
    expect(linkBlock).toEqual(expect.stringContaining("webRelayauthApiKey"));
    expect(linkBlock).toEqual(expect.stringContaining("WorkflowLaunchQueue"));
    expect(linkBlock).toEqual(expect.stringContaining("workflowStorage"));
  });
});
