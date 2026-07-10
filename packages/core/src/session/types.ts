export type SessionEventType =
  | 'workflow_started'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'sandbox_created'
  | 'sandbox_disposed'
  | 'heartbeat';

export interface SessionEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: SessionEventType;
  stepName?: string | null;
  sandboxId?: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface EmitEventOptions {
  runId: string;
  eventType: SessionEventType;
  stepName?: string;
  sandboxId?: string;
  payload?: Record<string, unknown>;
}

export interface GetSessionEventsOptions {
  after?: number;
  limit?: number;
  sort?: 'asc' | 'desc';
}

export interface EmitEventResult {
  /**
   * Sequence number assigned to the event that was just inserted. Callers
   * that need "the ID of the event I just created" must use this value
   * rather than calling getLatestSequence — that would race under
   * concurrent writes to the same runId and could return a later event's
   * sequence.
   */
  sequence: number;
}

export interface SessionEventClient {
  emit(options: EmitEventOptions): Promise<EmitEventResult>;
  getEvents(runId: string, options?: GetSessionEventsOptions): Promise<SessionEvent[]>;
  getLatestSequence(runId: string): Promise<number>;
}
