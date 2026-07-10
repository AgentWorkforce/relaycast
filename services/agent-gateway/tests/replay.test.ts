import assert from "node:assert/strict";
import { test } from "vitest";

import { readReplayEvents } from "../src/replay.js";

test('readReplayEvents replays the last matching N relayfile changes in ascending order', async () => {
  const pages = [
    {
      events: [
        {
          eventId: "evt_3",
          type: "file.updated",
          path: "/linear/issues/ENG-2.json",
          revision: "rev_3",
          timestamp: "2026-05-12T01:00:03.000Z",
        },
        {
          eventId: "evt_2",
          type: "file.updated",
          path: "/linear/issues/ENG-1.json",
          revision: "rev_2",
          timestamp: "2026-05-12T01:00:02.000Z",
        },
      ],
      nextCursor: "page-2",
    },
    {
      events: [
        {
          eventId: "evt_1",
          type: "file.updated",
          path: "/github/prs/42.json",
          revision: "rev_1",
          timestamp: "2026-05-12T01:00:01.000Z",
        },
      ],
      nextCursor: undefined,
    },
  ];
  let pageIndex = 0;

  const replayed = await readReplayEvents(
    {
      async getEvents() {
        return pages[pageIndex++]!;
      },
    } as never,
    {
      workspace: "support",
      replayOnStart: "last:2",
      globs: ["/linear/issues/**"],
    },
  );

  assert.deepEqual(
    replayed.map((event) => ({ eventId: event.eventId, path: event.path })),
    [
      { eventId: "evt_2", path: "/linear/issues/ENG-1.json" },
      { eventId: "evt_3", path: "/linear/issues/ENG-2.json" },
    ],
  );
});

test('readReplayEvents respects since:<iso> when the relayfile client exposes listChangesSince', async () => {
  const replayed = await readReplayEvents(
    {
      async getEvents() {
        throw new Error('getEvents should not be called when listChangesSince is available');
      },
      async listChangesSince() {
        return [
          {
            eventId: 'evt_before',
            type: 'file.updated',
            path: '/github/prs/42.json',
            revision: 'rev_before',
            timestamp: '2026-05-10T23:59:59.000Z',
          },
          {
            eventId: 'evt_after_1',
            type: 'file.updated',
            path: '/linear/issues/ENG-1.json',
            revision: 'rev_after_1',
            timestamp: '2026-05-11T00:00:01.000Z',
          },
          {
            eventId: 'evt_after_2',
            type: 'file.updated',
            path: '/linear/issues/ENG-2.json',
            revision: 'rev_after_2',
            timestamp: '2026-05-11T00:00:02.000Z',
          },
        ];
      },
    } as never,
    {
      workspace: 'support',
      replayOnStart: 'since:2026-05-11T00:00:00.000Z',
      globs: ['/linear/issues/**'],
    },
  );

  assert.deepEqual(
    replayed.map((event) => event.eventId),
    ['evt_after_1', 'evt_after_2'],
  );
});

test('readReplayEvents keeps scanning a since:<iso> page when a newer matching event appears after an older sibling', async () => {
  const replayed = await readReplayEvents(
    {
      async getEvents() {
        return {
          events: [
            {
              eventId: 'evt_old',
              type: 'file.updated',
              path: '/linear/issues/ENG-1.json',
              revision: 'rev_old',
              timestamp: '2026-05-10T23:59:59.000Z',
            },
            {
              eventId: 'evt_new',
              type: 'file.updated',
              path: '/linear/issues/ENG-2.json',
              revision: 'rev_new',
              timestamp: '2026-05-11T00:00:01.000Z',
            },
          ],
          nextCursor: null,
        };
      },
    } as never,
    {
      workspace: 'support',
      replayOnStart: 'since:2026-05-11T00:00:00.000Z',
      globs: ['/linear/issues/**'],
    },
  );

  assert.deepEqual(replayed.map((event) => event.eventId), ['evt_new']);
});

test("readReplayEvents accepts proactive ChangeEvent replay payloads", async () => {
  const replayed = await readReplayEvents(
    {
      async getEvents() {
        throw new Error("getEvents should not be called when listLastNChanges is available");
      },
      async listLastNChanges() {
        return {
          events: [
            {
              id: "evt_older",
              workspace: "support",
              type: "relayfile.changed",
              occurredAt: "2026-05-12T01:00:01.000Z",
              resource: {
                path: "/linear/issues/ENG-9.json",
                kind: "linear.issue",
                id: "ENG-9",
                provider: "linear",
              },
              summary: {
                title: "ENG-9",
                status: "Todo",
              },
              digest: "sha256:older",
            },
            {
              id: "evt_newer",
              workspace: "support",
              type: "relayfile.changed",
              occurredAt: "2026-05-12T01:00:02.000Z",
              resource: {
                path: "/linear/issues/ENG-10.json",
                kind: "linear.issue",
                id: "ENG-10",
                provider: "linear",
              },
              summary: {
                title: "ENG-10",
                status: "In Progress",
              },
              digest: "sha256:newer",
            },
          ],
        };
      },
    } as never,
    {
      workspace: "support",
      replayOnStart: "last:2",
      globs: ["/linear/issues/**"],
    },
  );

  assert.deepEqual(
    replayed.map((event) => ({
      eventId: event.eventId,
      path: event.path,
      digest: event.digest,
      provider: event.provider,
    })),
    [
      {
        eventId: "evt_older",
        path: "/linear/issues/ENG-9.json",
        digest: "sha256:older",
        provider: "linear",
      },
      {
        eventId: "evt_newer",
        path: "/linear/issues/ENG-10.json",
        digest: "sha256:newer",
        provider: "linear",
      },
    ],
  );
});
