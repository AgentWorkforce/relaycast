import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  materializeRelayfileGithubClone,
  repoPathFromCloneCachePath,
  type RelayfileCloneClient,
} from "../packages/core/src/clone/relayfile-clone-materializer";

describe("relayfile GitHub clone materializer", () => {
  it("maps cache paths back to repo paths", () => {
    expect(repoPathFromCloneCachePath({
      path: "/github/repos/AgentWorkforce/cloud/contents/src/index.ts@abc123.json",
      owner: "AgentWorkforce",
      repo: "cloud",
      headSha: "abc123",
    })).toBe("src/index.ts");

    expect(repoPathFromCloneCachePath({
      path: "/github/repos/AgentWorkforce/cloud/contents/packages/web/a%20b.ts@abc123.json",
      owner: "AgentWorkforce",
      repo: "cloud",
      headSha: "abc123",
    })).toBe("packages/web/a b.ts");
  });

  it("materializes utf8 and base64 files into a normal working tree", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "relayfile-materialize-"));
    const files = new Map<string, { content: string; encoding?: string }>([
      [
        "/github/repos/AgentWorkforce/cloud/.relayfile/clone.json",
        { content: JSON.stringify({ headSha: "abc123" }) },
      ],
      [
        "/github/repos/AgentWorkforce/cloud/contents/README.md@abc123.json",
        { content: "# Cloud\n" },
      ],
      [
        "/github/repos/AgentWorkforce/cloud/contents/src/data.bin@abc123.json",
        { content: Buffer.from([0, 1, 2, 3]).toString("base64"), encoding: "base64" },
      ],
    ]);
    const client: RelayfileCloneClient = {
      async listTree(_workspaceId, input) {
        expect(input.path).toBe("/github/repos/AgentWorkforce/cloud/contents");
        return {
          entries: [...files.keys()]
            .filter((filePath) => filePath.includes("/contents/"))
            .map((filePath) => ({ path: filePath, type: "file" })),
        };
      },
      async readFile(_workspaceId, filePath) {
        const file = files.get(filePath);
        if (!file) throw new Error(`missing ${filePath}`);
        return file;
      },
    };

    try {
      await expect(materializeRelayfileGithubClone({
        client,
        workspaceId: "rw_123",
        owner: "AgentWorkforce",
        repo: "cloud",
        targetDir: tmp,
      })).resolves.toEqual({ headSha: "abc123", filesWritten: 2 });

      await expect(readFile(path.join(tmp, "README.md"), "utf8")).resolves.toBe("# Cloud\n");
      await expect(readFile(path.join(tmp, "src/data.bin"))).resolves.toEqual(Buffer.from([0, 1, 2, 3]));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
