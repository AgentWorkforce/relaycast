import { nodeFrameKindFor } from '@relaycast/types';
import type { EngineConfig, EngineDb, EngineDeps } from '../ports/index.js';
import { transformForClient, type WsEvent } from './wsTransform.js';
import {
  appendAndPublishWorkspaceEvent,
  appendAndPublishWorkspaceEventBatch,
} from './workspaceEvents.js';
import {
  sendNodeContextEventsToAgents,
  sendNodeContextForChannel,
  sendNodeContextToAgents,
  sendNodePresenceContext,
} from './nodeContext.js';

/**
 * The single place that decides which sinks a workspace event reaches.
 *
 * Every event is appended to the durable workspace event log and published to
 * the workspace observer stream. Whether it is *also* pushed to the nodes that
 * host the audience agents is decided by two things, in this order:
 *
 * 1. The node frame that carries the event, declared in `@relaycast/types`
 *    (`nodeFrameKindFor`). `deliver`-frame types are already sent by the
 *    delivery pipeline, so they are never re-sent here as a `context.update`.
 * 2. The dispatch scope. Workspace-wide events have no node audience; channel,
 *    agent, and presence scopes each resolve their own node bindings.
 *
 * Sinks are independent: they run concurrently and a failure in one is reported
 * through `onSinkError` without stopping the others.
 */

/** The sinks a dispatched event can reach. Used to label failures. */
export type EventSink = 'workspace_stream' | 'node_context';

/** Reports a per-sink failure; the other sinks still run. */
export type EventSinkErrorHandler = (sink: EventSink, err: unknown) => void;

/** The audience an event's `context.update` node push is resolved against. */
export type EventDispatchScope =
  | { kind: 'workspace' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'agents'; agentIds: readonly string[] }
  | { kind: 'presence'; subjectAgentId: string };

/** The subset of the engine runtime the dispatcher needs. */
export type EventDispatchEngine = Pick<EngineDeps, 'realtime' | 'nodeConnections'> & {
  config?: EngineConfig;
};

/** Everything {@link publishEvent} needs: the database plus the engine ports. */
export interface EventDispatchDeps {
  db: EngineDb;
  engine: EventDispatchEngine;
}

/** One event to dispatch, plus the audience its node push resolves against. */
export interface PublishEventArgs {
  workspaceId: string;
  type: string;
  data: Record<string, unknown>;
  scope: EventDispatchScope;
  onSinkError?: EventSinkErrorHandler;
}

/** One agent-scoped event in a {@link publishEventsToAgents} batch. */
export interface ScopedAgentEvent {
  workspaceId: string;
  agentId: string;
  type: string;
  data: Record<string, unknown>;
}

/** Build the raw workspace event frame published to observers and logged. */
function buildEvent(
  type: string,
  workspaceId: string,
  data: Record<string, unknown>,
  channelId?: string,
): WsEvent {
  return {
    type,
    workspace_id: workspaceId,
    channel_id: channelId,
    data,
    timestamp: new Date().toISOString(),
  };
}

/** Narrow the dispatcher deps to the transport deps `engine/nodeContext.ts` takes. */
function nodeContextDeps(deps: EventDispatchDeps, workspaceId: string) {
  return {
    db: deps.db,
    nodeConnections: deps.engine.nodeConnections,
    realtime: deps.engine.realtime,
    workspaceId,
    environment: deps.engine.config?.environment,
    httpPushProxy: deps.engine.config?.httpPushProxy,
  };
}

/** Node context carries only `context`-frame events, and workspace-wide events have no node audience. */
function reachesNodeContext(type: string, scope: EventDispatchScope): boolean {
  if (scope.kind === 'workspace') return false;
  return nodeFrameKindFor(type) === 'context';
}

/** Resolve the scope's node audience and push one `context.update`; `null` when the scope has none. */
function pushNodeContext(
  deps: EventDispatchDeps,
  args: PublishEventArgs,
): Promise<void> | null {
  const { scope, type, data, workspaceId } = args;
  switch (scope.kind) {
    case 'channel':
      return sendNodeContextForChannel(nodeContextDeps(deps, workspaceId), {
        channelId: scope.channelId,
        topic: type.startsWith('thread.') ? 'thread' : 'channel',
        event: type,
        data,
      });
    case 'agents':
      return sendNodeContextToAgents(nodeContextDeps(deps, workspaceId), {
        agentIds: [...new Set(scope.agentIds)],
        event: type,
        data,
      });
    case 'presence':
      return sendNodePresenceContext(nodeContextDeps(deps, workspaceId), {
        subjectAgentId: scope.subjectAgentId,
        event: type,
        data,
      });
    case 'workspace':
      return null;
  }
}

/**
 * Dispatch one workspace event to every sink it reaches. Best-effort by
 * contract: this never throws, so callers can hand it straight to
 * `runInBackground`.
 */
export async function publishEvent(
  deps: EventDispatchDeps,
  args: PublishEventArgs,
): Promise<void> {
  const channelId = args.scope.kind === 'channel' ? args.scope.channelId : undefined;
  const payload = transformForClient(buildEvent(args.type, args.workspaceId, args.data, channelId));

  const tasks: Promise<unknown>[] = [
    appendAndPublishWorkspaceEvent(
      { db: deps.db, realtime: deps.engine.realtime },
      args.workspaceId,
      { type: args.type, channelId: channelId ?? null, payload },
      (err) => args.onSinkError?.('workspace_stream', err),
    ).catch((err) => args.onSinkError?.('workspace_stream', err)),
  ];

  if (reachesNodeContext(args.type, args.scope)) {
    const push = pushNodeContext(deps, args);
    if (push) {
      tasks.push(push.catch((err) => args.onSinkError?.('node_context', err)));
    }
  }

  await Promise.allSettled(tasks);
}

/**
 * Batch form for agent-scoped events across workspaces: one bounded log append
 * and one bounded node-binding resolution for the whole batch. Same sink rules
 * as {@link publishEvent}.
 */
export async function publishEventsToAgents(
  deps: EventDispatchDeps,
  events: readonly ScopedAgentEvent[],
  onSinkError?: EventSinkErrorHandler,
): Promise<void> {
  if (events.length === 0) return;

  const inputs = events.map((event) => ({
    workspaceId: event.workspaceId,
    input: {
      type: event.type,
      payload: transformForClient(buildEvent(event.type, event.workspaceId, event.data)),
    },
  }));
  const contextEvents = events
    .filter((event) => nodeFrameKindFor(event.type) === 'context')
    .map((event) => ({
      workspaceId: event.workspaceId,
      agentId: event.agentId,
      event: event.type,
      data: event.data,
    }));

  const tasks: Promise<unknown>[] = [
    appendAndPublishWorkspaceEventBatch(
      { db: deps.db, realtime: deps.engine.realtime },
      inputs,
      (err) => onSinkError?.('workspace_stream', err),
    ).catch((err) => onSinkError?.('workspace_stream', err)),
  ];
  if (contextEvents.length > 0) {
    tasks.push(
      sendNodeContextEventsToAgents(
        {
          db: deps.db,
          nodeConnections: deps.engine.nodeConnections,
          realtime: deps.engine.realtime,
          environment: deps.engine.config?.environment,
          httpPushProxy: deps.engine.config?.httpPushProxy,
        },
        contextEvents,
      ).catch((err) => onSinkError?.('node_context', err)),
    );
  }

  await Promise.allSettled(tasks);
}
