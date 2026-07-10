import type {
  SessionEvent,
  EmitEventOptions,
  EmitEventResult,
  GetSessionEventsOptions,
  SessionEventClient,
} from './types.js';

export type {
  SessionEvent,
  EmitEventOptions,
  EmitEventResult,
  GetSessionEventsOptions,
  SessionEventClient,
};

const MAX_SEQUENCE_INSERT_RETRIES = 25;

function isSequenceConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { code?: unknown; message?: unknown; cause?: unknown };

  if (err.code === '23505') {
    return true;
  }

  const message = typeof err.message === 'string' ? err.message : '';
  if (
    message.includes('session_events_run_sequence_unique') ||
    message.includes('duplicate key value violates unique constraint') ||
    message.includes('UNIQUE constraint failed')
  ) {
    return true;
  }

  // Drizzle wraps driver errors — recurse into cause.
  if (err.cause && err.cause !== error) {
    return isSequenceConflictError(err.cause);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP-based event client for use inside sandboxes.
 * Calls the cloud API to persist events.
 */
export function createHttpEventClient(config: {
  cloudApiUrl: string;
  accessToken: string;
}): SessionEventClient {
  const { cloudApiUrl, accessToken } = config;

  return {
    async emit(options) {
      const url = `${cloudApiUrl}/api/v1/workflows/runs/${options.runId}/events`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            eventType: options.eventType,
            stepName: options.stepName,
            sandboxId: options.sandboxId,
            payload: options.payload ?? {},
          }),
        });
        if (!res.ok) {
          console.warn(`[session-events] emit ${options.eventType} failed: ${res.status}`);
          return { sequence: 0 };
        }
        // The POST handler returns { runId, sequence } carrying the
        // sequence assigned by the server — surface it so callers can
        // reference the event they just created without a racy
        // getLatestSequence follow-up call.
        const body = (await res.json().catch(() => null)) as
          | { sequence?: number }
          | null;
        return { sequence: typeof body?.sequence === 'number' ? body.sequence : 0 };
      } catch (err) {
        console.warn(`[session-events] emit ${options.eventType} error:`, err);
        return { sequence: 0 };
      }
    },

    async getEvents(runId, options) {
      const params = new URLSearchParams();
      if (options?.after !== undefined) params.set('after', String(options.after));
      if (options?.limit !== undefined) params.set('limit', String(options.limit));
      if (options?.sort !== undefined) params.set('sort', options.sort);
      const url = `${cloudApiUrl}/api/v1/workflows/runs/${runId}/events?${params}`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { events: SessionEvent[] };
        return data.events;
      } catch {
        return [];
      }
    },

    async getLatestSequence(runId) {
      const events = await this.getEvents(runId, { limit: 1, sort: 'desc' });
      return events.length > 0 ? events[0].sequence : 0;
    },
  };
}

/**
 * Direct DB event client for use in the API layer.
 * Accepts a Drizzle db instance and the schema.
 */
export function createDbEventClient(deps: {
  db: any;
  schema: { sessionEvents: any };
}): SessionEventClient {
  const { db, schema } = deps;

  return {
    async emit(options) {
      const { randomUUID } = await import('node:crypto');
      const { sql } = await import('drizzle-orm');

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_SEQUENCE_INSERT_RETRIES; attempt += 1) {
        const maxResult = await db
          .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.sessionEvents.sequence}), 0)` })
          .from(schema.sessionEvents)
          .where(sql`${schema.sessionEvents.runId} = ${options.runId}`);

        const nextSeq = (maxResult[0]?.maxSeq ?? 0) + 1;

        try {
          await db.insert(schema.sessionEvents).values({
            id: randomUUID(),
            runId: options.runId,
            sequence: nextSeq,
            eventType: options.eventType,
            stepName: options.stepName ?? null,
            sandboxId: options.sandboxId ?? null,
            payload: JSON.stringify(options.payload ?? {}),
            createdAt: new Date(),
          });
          return { sequence: nextSeq };
        } catch (error) {
          lastError = error;
          if (!isSequenceConflictError(error)) {
            throw error;
          }
          // Jittered backoff — reduce herd effects under high contention.
          await sleep(Math.floor(Math.random() * 8) + 1);
        }
      }
      throw lastError ?? new Error('emit: exhausted sequence retries');
    },

    async getEvents(runId, options?: GetSessionEventsOptions) {
      const { eq, gt, and, asc, desc } = await import('drizzle-orm');

      const conditions = options?.after !== undefined
        ? and(
            eq(schema.sessionEvents.runId, runId),
            gt(schema.sessionEvents.sequence, options.after),
          )
        : eq(schema.sessionEvents.runId, runId);

      let query = db
        .select()
        .from(schema.sessionEvents)
        .where(conditions)
        .orderBy((options?.sort === 'desc' ? desc : asc)(schema.sessionEvents.sequence));

      // Defensive: apply the limit when an explicit non-negative value is
      // supplied. `if (options?.limit)` skipped 0 as falsy, which silently
      // returned every row in the table — flagged by Devin review.
      if (options?.limit !== undefined && options.limit !== null && options.limit >= 0) {
        query = query.limit(options.limit);
      }

      const rows = await query;
      return rows.map((row: any) => ({
        ...row,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      }));
    },

    async getLatestSequence(runId) {
      const events = await this.getEvents(runId, { limit: 1, sort: 'desc' });
      return events.length > 0 ? events[0].sequence : 0;
    },
  };
}
