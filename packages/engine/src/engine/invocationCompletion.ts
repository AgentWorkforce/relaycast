import { transformForClient } from './wsTransform.js';
import { enqueueEvent } from './eventQueue.js';
import type { EngineDeps } from '../ports/index.js';
import { sendNodeDeliveriesToAgents } from './nodeDeliver.js';

export type InvocationCompletionDeps = Pick<EngineDeps, 'db' | 'realtime' | 'webhookQueue' | 'nodeConnections'>;

type CompletionResult = {
  invocation_id: string;
  action_name: string;
  caller_id: string | null;
  status: string;
  output: unknown;
  error: string | null;
};

function buildEvent(type: string, workspaceId: string, data: Record<string, unknown>) {
  return {
    type,
    workspace_id: workspaceId,
    data,
    timestamp: new Date().toISOString(),
  };
}

export async function emitInvocationCompletionEffects(
  deps: InvocationCompletionDeps,
  workspaceId: string,
  result: CompletionResult,
): Promise<void> {
  const eventType = result.status === 'failed' ? 'action.failed' : 'action.completed';
  const eventPayload = {
    invocation_id: result.invocation_id,
    action_name: result.action_name,
    status: result.status,
    output: result.output,
    error: result.error,
  };
  const event = buildEvent(eventType, workspaceId, eventPayload);
  const payload = transformForClient(event);

  const fanoutTasks: Promise<unknown>[] = [];
  if (result.caller_id) {
    fanoutTasks.push(
      sendNodeDeliveriesToAgents({
        db: deps.db,
        nodeConnections: deps.nodeConnections,
        workspaceId,
      }, {
        agentIds: [result.caller_id],
        event: eventType,
        eventKey: result.invocation_id,
        data: eventPayload,
        messageId: result.invocation_id,
      }),
    );
  }
  fanoutTasks.push(deps.realtime.publishToWorkspaceStream({ workspaceId, event: payload }));
  await Promise.allSettled(fanoutTasks);

  let outboxId: string | undefined;
  try {
    outboxId = await enqueueEvent(deps.db, workspaceId, eventType, result as Record<string, unknown>);
  } catch {
    // Best-effort: if the durable outbox row can't be inserted, still try the queue send.
  }

  try {
    await deps.webhookQueue.send(outboxId ? { type: eventType, workspaceId, data: result, outboxId } : {
      type: eventType,
      workspaceId,
      data: result,
    });
  } catch {
    // Best-effort side effect; completion must not fail because webhook delivery did.
  }
}
