import { transformForClient } from './wsTransform.js';
import { enqueueEvent } from './eventQueue.js';
import { isWorkspaceStreamEnabled } from '../lib/workspaceStream.js';
import type { EngineDeps } from '../ports/index.js';

export type InvocationCompletionDeps = Pick<EngineDeps, 'db' | 'realtime' | 'webhookQueue' | 'kv' | 'config' | 'presence'>;

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
      deps.realtime.deliverToAgents({
        workspaceId,
        agentIds: [result.caller_id],
        event: payload,
      }),
    );
  }
  if (await isWorkspaceStreamEnabled(deps.kv, workspaceId, deps.config?.workspaceStreamEnabled ?? false)) {
    fanoutTasks.push(deps.realtime.publishToWorkspaceStream({ workspaceId, event: payload }));
  }
  try {
    const onlineAgentIds = await deps.presence.getOnline(workspaceId);
    if (onlineAgentIds.length > 0) {
      fanoutTasks.push(deps.realtime.deliverToAgents({ workspaceId, agentIds: onlineAgentIds, event: payload }));
    }
  } catch {
    // Presence fanout is best-effort.
  }
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
