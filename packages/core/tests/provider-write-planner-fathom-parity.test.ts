import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  assertMalformedNangoMessageAcked,
  assertTodayDigestIncludes,
  assertWriterEmitsPaths,
} from "./provider-write-planner-smoke-helpers.js";

const createdAt = "2026-05-22T20:38:43Z";

const fathomMeeting = {
  id: "148996864",
  recording_id: 148996864,
  title: "Fathom Demo",
  meeting_title: "Fathom Demo",
  url: "https://fathom.video/calls/684490099",
  share_url: "https://fathom.video/share/sr9joqCxPs6QjrxwrUS_tbeUzfLYnTY7",
  created_at: createdAt,
  scheduled_start_time: "2021-09-16T20:40:00Z",
  scheduled_end_time: "2021-09-16T21:00:00Z",
  recording_start_time: "2021-09-16T20:42:47Z",
  recording_end_time: createdAt,
  calendar_invitees_domains_type: "only_internal",
  transcript_language: "unknown",
  transcript: null,
  default_summary: null,
  action_items: [],
  calendar_invitees: [],
  recorded_by: {
    name: "Khaliq Gant",
    email: "khaliq@agentrelay.com",
    email_domain: "agentrelay.com",
    team: null,
  },
  crm_matches: { error: "No CRM connected" },
};

function fathomJob(): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "fathom",
    providerConfigKey: "fathom-relay",
    connectionId: "conn_test",
    syncName: "fetch-meetings",
    model: "FathomMeeting",
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

describe("fathom-relay smoke parity", () => {
  it("writes canonical, index, and by-id alias paths", async () => {
    const expected = [
      "/fathom/meetings/148996864.json",
      "/fathom/meetings/_index.json",
      "/fathom/meetings/by-id/148996864.json",
    ];
    await assertWriterEmitsPaths(fathomJob(), fathomMeeting, expected);
  });

  it("surfaces a Fathom record in today's digest", async () => {
    await assertTodayDigestIncludes(
      "fathom",
      "/fathom/meetings/148996864.json",
      JSON.stringify(fathomMeeting),
    );
  });

  it("acks malformed provider queue bodies without retrying", async () => {
    await assertMalformedNangoMessageAcked("fathom-relay", "fetch-meetings", "FathomMeeting");
  });
});
