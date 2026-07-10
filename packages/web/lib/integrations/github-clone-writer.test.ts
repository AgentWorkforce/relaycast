import { describe, expect, it } from "vitest";

import {
  chunkedBulkWrite,
  GITHUB_CLONE_CHUNK_SIZE,
  GITHUB_CLONE_MAX_CONCURRENT,
} from "./github-clone-writer";

function makeFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/github/repos/AgentWorkforce/cloud/file-${index}.ts`,
    content: `export const file${index} = ${index};\n`,
    encoding: "utf-8" as const,
  }));
}

describe("GitHub clone writer", () => {
  it("defaults to small serial chunks", () => {
    expect(GITHUB_CLONE_CHUNK_SIZE).toBe(25);
    expect(GITHUB_CLONE_MAX_CONCURRENT).toBe(1);
  });

  it("splits default writes into 25-file chunks", async () => {
    const chunkSizes: number[] = [];
    const client = {
      async bulkWrite(input: { files: unknown[] }) {
        chunkSizes.push(input.files.length);
        return {
          written: input.files.length,
          errors: [],
        };
      },
    };

    const result = await chunkedBulkWrite({
      client: client as never,
      workspaceId: "workspace-1",
      files: makeFiles(51),
    });

    expect(chunkSizes).toEqual([25, 25, 1]);
    expect(result).toEqual({
      written: 51,
      errors: [],
    });
  });
});
