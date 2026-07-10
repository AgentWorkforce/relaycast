import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunkedBulkWrite,
  GITHUB_CLONE_CHUNK_SIZE,
  GITHUB_CLONE_MAX_CONCURRENT,
} from "../src/clone/github-clone-writer.js";

function makeFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/github/repos/AgentWorkforce/cloud/file-${index}.ts`,
    content: `export const file${index} = ${index};\n`,
    encoding: "utf-8" as const,
  }));
}

test("GitHub clone writer defaults to small serial chunks", () => {
  assert.equal(GITHUB_CLONE_CHUNK_SIZE, 25);
  assert.equal(GITHUB_CLONE_MAX_CONCURRENT, 1);
});

test("GitHub clone writer splits default writes into 25-file chunks", async () => {
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

  assert.deepEqual(chunkSizes, [25, 25, 1]);
  assert.equal(result.written, 51);
  assert.deepEqual(result.errors, []);
});
