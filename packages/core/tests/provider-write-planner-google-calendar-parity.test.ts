import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  assertHasPath,
  assertMalformedNangoMessageAcked,
  assertTodayDigestIncludes,
  assertWriterEmitsPaths,
  planSmokeWrites,
} from "./provider-write-planner-smoke-helpers.js";

const googleCalendarEvent = {
  id: "primary:evt-1",
  calendarId: "primary",
  eventId: "evt-1",
  status: "confirmed",
  summary: "Design Review",
  lastEditedTime: "2026-05-19T10:00:00.000Z",
  start: { dateTime: "2026-05-21T09:00:00Z" },
  end: { dateTime: "2026-05-21T10:00:00Z" },
  organizer: { email: "alice@example.com" },
  attendees: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
};

const samples = {
  GoogleCalendar: {
    id: "primary",
    summary: "Primary Calendar",
    timeZone: "Etc/UTC",
    primary: true,
  },
  GoogleCalendarEvent: googleCalendarEvent,
  GoogleCalendarSetting: {
    id: "timezone",
    value: "Etc/UTC",
  },
  GoogleCalendarAcl: {
    id: "primary:rule-1",
    calendarId: "primary",
    ruleId: "rule-1",
    role: "reader",
    scope: { type: "user", value: "alice@example.com" },
  },
  GoogleCalendarColor: {
    id: "calendar:1",
    colorType: "calendar",
    colorId: "1",
    background: "#ac725e",
    foreground: "#1d1d1d",
    updated: "2026-05-20T09:00:00.000Z",
  },
  GoogleCalendarWatchRenewal: {
    id: "google-calendar-watch-1",
    renewed_at: "2026-05-20T09:00:00.000Z",
    previous_channel_count: 1,
    new_channel_count: 2,
    stopped_channel_count: 1,
    failed_stop_channel_count: 0,
    watch_resource_uris_json: "[\"https://www.googleapis.com/calendar/v3/calendars/primary/events\"]",
    expires_at: "2026-05-21T09:00:00.000Z",
  },
};

const schemas = {
  GoogleCalendar: z.object({
    id: z.string(),
    summary: z.string().optional(),
    timeZone: z.string().optional(),
    primary: z.boolean().optional(),
  }).passthrough(),
  GoogleCalendarEvent: z.object({
    id: z.string(),
    calendarId: z.string(),
    eventId: z.string(),
    status: z.string().optional(),
    summary: z.string().optional(),
    start: z.record(z.string(), z.unknown()).optional(),
    end: z.record(z.string(), z.unknown()).optional(),
    organizer: z.record(z.string(), z.unknown()).optional(),
    attendees: z.array(z.record(z.string(), z.unknown())).optional(),
  }).passthrough(),
  GoogleCalendarSetting: z.object({
    id: z.string(),
    value: z.string(),
  }).passthrough(),
  GoogleCalendarAcl: z.object({
    id: z.string(),
    calendarId: z.string(),
    ruleId: z.string(),
    role: z.string().optional(),
    scope: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  GoogleCalendarColor: z.object({
    id: z.string(),
    colorType: z.enum(["calendar", "event"]),
    colorId: z.string(),
    background: z.string().optional(),
    foreground: z.string().optional(),
    updated: z.string().optional(),
  }).passthrough(),
  GoogleCalendarWatchRenewal: z.object({
    id: z.string(),
    renewed_at: z.string(),
    previous_channel_count: z.number(),
    new_channel_count: z.number(),
    stopped_channel_count: z.number(),
    failed_stop_channel_count: z.number(),
    watch_resource_uris_json: z.string().optional(),
    expires_at: z.string().optional(),
  }),
};

function googleCalendarJob(): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "google-calendar",
    providerConfigKey: "google-calendar-relay",
    connectionId: "conn_test",
    syncName: "fetch-events",
    model: "GoogleCalendarEvent",
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

describe("google-calendar-relay smoke parity", () => {
  it("sampled records satisfy the declared zod contracts", () => {
    for (const [model, schema] of Object.entries(schemas)) {
      assert.ok(
        schema.safeParse(samples[model as keyof typeof samples]).success,
        `${model} sample should satisfy schema`,
      );
    }
  });

  it("plans and writes canonical, index, and one by-* alias path", async () => {
    const expected = [
      "/google-calendar/calendars/primary/events/evt-1.json",
      "/google-calendar/events/_index.json",
      "/google-calendar/events/by-calendar/primary/_index.json",
    ];
    const writes = planSmokeWrites(googleCalendarJob(), googleCalendarEvent);
    for (const path of expected) assertHasPath(writes, path);

    await assertWriterEmitsPaths(googleCalendarJob(), googleCalendarEvent, expected);
  });

  it("surfaces a Google Calendar record in today's digest", async () => {
    await assertTodayDigestIncludes(
      "google-calendar",
      "/google-calendar/calendars/primary/events/evt-1.json",
      JSON.stringify(googleCalendarEvent),
    );
  });

  it("acks malformed provider queue bodies without retrying", async () => {
    await assertMalformedNangoMessageAcked(
      "google-calendar-relay",
      "fetch-events",
      "GoogleCalendarEvent",
    );
  });
});
