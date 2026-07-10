import { describe, it } from "node:test";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  assertMalformedNangoMessageAcked,
  assertTodayDigestIncludes,
  assertWriterEmitsPaths,
} from "./provider-write-planner-smoke-helpers.js";

const dropboxFile = {
  id: "/engineering/q2-plan.md",
  dropbox_id: "id:abc123",
  name: "q2-plan.md",
  path_lower: "/engineering/q2-plan.md",
  path_display: "/Engineering/Q2-Plan.md",
  rev: "a1c10ce0dd78",
  size: 1024,
  server_modified: "2026-05-25T08:00:00.000Z",
  client_modified: "2026-05-25T07:58:00.000Z",
};

const dropboxFolder = {
  id: "/engineering",
  dropbox_id: "id:folder123",
  name: "Engineering",
  path_lower: "/engineering",
  path_display: "/Engineering",
};

const dropboxSharedFolder = {
  id: "845281924",
  shared_folder_id: "845281924",
  shared_folder_name: "Finance Shared",
};

const dropboxSharedLink = {
  id: "sl:ZXhhbXBsZS1saW5r",
  name: "Q2 Plan Link",
  url: "https://www.dropbox.com/scl/fi/example/q2-plan.md",
};

function dropboxJob(
  syncName: string,
  model: string,
): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "dropbox",
    providerConfigKey: "dropbox-relay",
    connectionId: "conn_test",
    syncName,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

describe("dropbox-relay smoke parity", () => {
  it("writes canonical, index, and alias paths for metadata sync models", async () => {
    await assertWriterEmitsPaths(
      dropboxJob("fetch-files", "DropboxFile"),
      dropboxFile,
      [
        "/dropbox/files/q2-plan-md__%2Fengineering%2Fq2-plan.md.json",
        "/dropbox/files/_index.json",
        "/dropbox/files/by-id/id%3Aabc123.json",
      ],
    );

    await assertWriterEmitsPaths(
      dropboxJob("fetch-folders", "DropboxFolder"),
      dropboxFolder,
      [
        "/dropbox/folders/engineering__%2Fengineering.json",
        "/dropbox/folders/_index.json",
        "/dropbox/folders/by-id/id%3Afolder123.json",
      ],
    );

    await assertWriterEmitsPaths(
      dropboxJob("fetch-shared-folders", "DropboxSharedFolder"),
      dropboxSharedFolder,
      [
        "/dropbox/shared-folders/finance-shared__845281924.json",
        "/dropbox/shared-folders/_index.json",
        "/dropbox/shared-folders/by-id/845281924.json",
      ],
    );

    await assertWriterEmitsPaths(
      dropboxJob("fetch-shared-links", "DropboxSharedLink"),
      dropboxSharedLink,
      [
        "/dropbox/shared-links/q2-plan-link__sl%3AZXhhbXBsZS1saW5r.json",
        "/dropbox/shared-links/_index.json",
        "/dropbox/shared-links/by-id/sl%3AZXhhbXBsZS1saW5r.json",
      ],
    );
  });

  it("surfaces Dropbox metadata records in today's digest", async () => {
    await assertTodayDigestIncludes(
      "dropbox",
      "/dropbox/files/q2-plan-md__%2Fengineering%2Fq2-plan.md.json",
      JSON.stringify(dropboxFile),
    );
  });

  it("acks malformed provider queue bodies without retrying", async () => {
    await assertMalformedNangoMessageAcked(
      "dropbox-relay",
      "fetch-files",
      "DropboxFile",
    );
  });
});
