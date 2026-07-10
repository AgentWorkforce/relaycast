import type { FilesystemEvent } from "@relayfile/sdk";

import { minimatch } from "minimatch";

import type { AgentEventSummary } from "./summary-builder.js";

export type ReplayOnStart = "none" | `last:${number}` | `since:${string}`;

type ReplayMode =
  | { kind: "none" }
  | { kind: "last"; count: number }
  | { kind: "since"; sinceIso: string; sinceMs: number };

type ReplayFilesystemEvent = FilesystemEvent & {
  contentHash?: string;
  digest?: string;
  summary?: AgentEventSummary;
};

type ReplayChangeLogQueryResult = {
  events?: Array<ReplayProactiveChangeEvent | FilesystemEvent>;
};

type ReplayProactiveChangeEvent = {
  id?: string;
  type?: string;
  occurredAt?: string;
  resource?: {
    path?: string;
    provider?: string;
  };
  digest?: string;
  summary?: AgentEventSummary;
};

const DEFAULT_PAGE_LIMIT = 200;

export async function readReplayEvents(
  relayfile: {
    getEvents(workspace: string, options?: { cursor?: string; limit?: number }): Promise<{
      events: FilesystemEvent[];
      nextCursor: string | null;
    }>;
    listChangesSince?: (
      sinceIso: string,
      options?: Record<string, unknown>,
    ) => Promise<ReplayChangeLogQueryResult | ReplayProactiveChangeEvent[] | FilesystemEvent[]>;
    listLastNChanges?: (
      limit: number,
      options?: Record<string, unknown>,
    ) => Promise<ReplayChangeLogQueryResult | ReplayProactiveChangeEvent[] | FilesystemEvent[]>;
  },
  input: {
    workspace: string;
    replayOnStart: ReplayOnStart;
    globs: string[];
  },
): Promise<ReplayFilesystemEvent[]> {
  const mode = parseReplayOnStart(input.replayOnStart);
  if (mode.kind === "none" || input.globs.length === 0) {
    return [];
  }

  if (mode.kind === "last" && typeof relayfile.listLastNChanges === "function") {
    const events = await relayfile.listLastNChanges(mode.count, {
      workspace: input.workspace,
    });
    return dedupeEventsById(
      readReplayChangeEvents(events)
        .filter(isRelayfileChangeEvent)
        .filter((event) => matchesAnyGlob(event.path, input.globs)),
    ).sort(compareEventsAscending);
  }

  if (mode.kind === "since" && typeof relayfile.listChangesSince === "function") {
    const events = await relayfile.listChangesSince(mode.sinceIso, {
      workspace: input.workspace,
    });
    return dedupeEventsById(
      readReplayChangeEvents(events)
        .filter(isRelayfileChangeEvent)
        .filter((event) => matchesAnyGlob(event.path, input.globs)),
    ).sort(compareEventsAscending);
  }

  const matched: ReplayFilesystemEvent[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await relayfile.getEvents(input.workspace, {
      cursor,
      limit:
        mode.kind === "last"
          ? Math.min(1_000, Math.max(DEFAULT_PAGE_LIMIT, mode.count))
          : DEFAULT_PAGE_LIMIT,
    });

    const events = (page.events ?? [])
      .map((event) => event as ReplayFilesystemEvent)
      .filter(isRelayfileChangeEvent)
      .filter((event) => matchesAnyGlob(event.path, input.globs));

    if (mode.kind === "last") {
      matched.push(...events);
      if (matched.length >= mode.count || !page.nextCursor) {
        break;
      }
      cursor = page.nextCursor ?? undefined;
      continue;
    }

    let pageSawNewerEvent = false;
    for (const event of events) {
      const eventTimeMs = Date.parse(event.timestamp);
      if (!Number.isFinite(eventTimeMs)) {
        continue;
      }
      if (eventTimeMs < mode.sinceMs) {
        continue;
      }
      pageSawNewerEvent = true;
      matched.push(event);
    }

    if (!pageSawNewerEvent || !page.nextCursor) {
      break;
    }

    cursor = page.nextCursor ?? undefined;
  }

  const deduped = dedupeEventsById(
    mode.kind === "last" ? matched.slice(0, mode.count) : matched,
  );
  return deduped.sort(compareEventsAscending);
}

export function parseReplayOnStart(value: ReplayOnStart | string | undefined): ReplayMode {
  const normalized = value?.trim() ?? "none";
  if (!normalized || normalized === "none") {
    return { kind: "none" };
  }

  if (normalized.startsWith("last:")) {
    const count = Number.parseInt(normalized.slice("last:".length), 10);
    return Number.isFinite(count) && count > 0
      ? { kind: "last", count }
      : { kind: "none" };
  }

  if (normalized.startsWith("since:")) {
    const sinceIso = normalized.slice("since:".length).trim();
    const sinceMs = Date.parse(sinceIso);
    return Number.isFinite(sinceMs)
      ? { kind: "since", sinceIso: new Date(sinceMs).toISOString(), sinceMs }
      : { kind: "none" };
  }

  return { kind: "none" };
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}

function matchesGlob(path: string, glob: string): boolean {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedGlob = glob.startsWith("/") ? glob : `/${glob}`;
  return (
    minimatch(normalizedPath, normalizedGlob, { dot: true })
    || minimatch(normalizedPath.slice(1), normalizedGlob.slice(1), { dot: true })
  );
}

function isRelayfileChangeEvent(event: FilesystemEvent): boolean {
  return (
    event.type === "file.updated"
    || event.type === "file.created"
    || event.type === "file.deleted"
    || event.type === "dir.created"
    || event.type === "dir.deleted"
  );
}

function readReplayChangeEvents(
  value: ReplayChangeLogQueryResult | ReplayProactiveChangeEvent[] | FilesystemEvent[],
): ReplayFilesystemEvent[] {
  const events = Array.isArray(value) ? value : value.events ?? [];
  return events
    .map(normalizeReplayEvent)
    .filter((event): event is ReplayFilesystemEvent => Boolean(event));
}

function normalizeReplayEvent(
  event: ReplayProactiveChangeEvent | FilesystemEvent,
): ReplayFilesystemEvent | null {
  if (
    typeof (event as FilesystemEvent).eventId === "string"
    && typeof (event as FilesystemEvent).path === "string"
    && typeof (event as FilesystemEvent).timestamp === "string"
  ) {
    return event as ReplayFilesystemEvent;
  }

  const proactiveEvent = event as ReplayProactiveChangeEvent;
  if (
    proactiveEvent.type !== "relayfile.changed"
    || typeof proactiveEvent.id !== "string"
    || typeof proactiveEvent.occurredAt !== "string"
    || typeof proactiveEvent.resource?.path !== "string"
  ) {
    return null;
  }

  return {
    eventId: proactiveEvent.id,
    type: "file.updated",
    path: proactiveEvent.resource.path,
    revision: proactiveEvent.digest ?? "",
    timestamp: proactiveEvent.occurredAt,
    ...(proactiveEvent.resource.provider ? { provider: proactiveEvent.resource.provider } : {}),
    ...(proactiveEvent.digest ? { contentHash: proactiveEvent.digest, digest: proactiveEvent.digest } : {}),
    ...(proactiveEvent.summary ? { summary: proactiveEvent.summary } : {}),
  };
}

function dedupeEventsById(events: ReplayFilesystemEvent[]): ReplayFilesystemEvent[] {
  const seen = new Set<string>();
  const deduped: ReplayFilesystemEvent[] = [];
  for (const event of events) {
    if (!event.eventId || seen.has(event.eventId)) {
      continue;
    }
    seen.add(event.eventId);
    deduped.push(event);
  }
  return deduped;
}

function compareEventsAscending(
  left: ReplayFilesystemEvent,
  right: ReplayFilesystemEvent,
): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  return left.eventId.localeCompare(right.eventId);
}
