import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { actions, actionInvocations, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

export async function registerAction(
  db: Db,
  workspaceId: string,
  data: {
    name: string;
    description: string;
    handler_agent: string;
    input_schema?: Record<string, unknown>;
    output_schema?: Record<string, unknown>;
    available_to?: string[];
  },
) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.handler_agent)));

  if (!agent) {
    throw codedError(`Agent "${data.handler_agent}" not found`, 'agent_not_found', 404);
  }

  const id = `act_${generateId()}`;
  const [action] = await db
    .insert(actions)
    .values({
      id,
      workspaceId,
      name: data.name,
      description: data.description,
      handlerAgentId: agent.id,
      inputSchema: data.input_schema ?? {},
      outputSchema: data.output_schema ?? {},
      availableTo: data.available_to ?? null,
    })
    .returning();

  return {
    id: action.id,
    name: action.name,
    description: action.description,
    handler_agent: data.handler_agent,
    input_schema: action.inputSchema,
    output_schema: action.outputSchema,
    available_to: action.availableTo ?? null,
    is_active: action.isActive,
    created_at: action.createdAt.toISOString(),
  };
}

export async function listActions(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentId: actions.handlerAgentId,
      handlerAgentName: agents.name,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .innerJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(eq(actions.workspaceId, workspaceId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    handler_agent: r.handlerAgentName,
    input_schema: r.inputSchema,
    output_schema: r.outputSchema,
    available_to: r.availableTo ?? null,
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getAction(db: Db, workspaceId: string, name: string) {
  const [row] = await db
    .select({
      id: actions.id,
      name: actions.name,
      description: actions.description,
      handlerAgentId: actions.handlerAgentId,
      handlerAgentName: agents.name,
      inputSchema: actions.inputSchema,
      outputSchema: actions.outputSchema,
      availableTo: actions.availableTo,
      isActive: actions.isActive,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .innerJoin(agents, eq(actions.handlerAgentId, agents.id))
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)));

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    handler_agent: row.handlerAgentName,
    input_schema: row.inputSchema,
    output_schema: row.outputSchema,
    available_to: row.availableTo ?? null,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function deleteAction(db: Db, workspaceId: string, name: string) {
  const result = await db
    .delete(actions)
    .where(and(eq(actions.workspaceId, workspaceId), eq(actions.name, name)))
    .returning();

  return result.length > 0;
}

export async function invokeAction(
  db: Db,
  workspaceId: string,
  actionName: string,
  data: {
    input?: Record<string, unknown>;
    caller_id?: string;
    caller_name?: string;
  },
) {
  const [action] = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.workspaceId, workspaceId),
        eq(actions.name, actionName),
        eq(actions.isActive, true),
      ),
    );

  if (!action) {
    throw codedError(`Action "${actionName}" not found`, 'action_not_found', 404);
  }

  // Check availableTo access control — deny if caller is absent OR not in the list
  if (action.availableTo && action.availableTo.length > 0) {
    if (!data.caller_name || !action.availableTo.includes(data.caller_name)) {
      const who = data.caller_name ? `Agent "${data.caller_name}"` : 'Caller';
      throw codedError(`${who} is not authorized to invoke action "${actionName}"`, 'action_denied', 403);
    }
  }

  const invocationId = `inv_${generateId()}`;
  const [invocation] = await db
    .insert(actionInvocations)
    .values({
      id: invocationId,
      workspaceId,
      actionId: action.id,
      actionName,
      callerId: data.caller_id ?? null,
      callerName: data.caller_name ?? null,
      input: data.input ?? {},
      status: 'invoked',
    })
    .returning();

  return {
    invocation_id: invocation.id,
    action_name: actionName,
    handler_agent_id: action.handlerAgentId,
    input: invocation.input,
    status: invocation.status,
    created_at: invocation.createdAt.toISOString(),
  };
}

export async function completeInvocation(
  db: Db,
  workspaceId: string,
  actionName: string,
  invocationId: string,
  data: {
    output?: Record<string, unknown>;
    error?: string;
    duration_ms?: number;
    caller_agent_id?: string;
  },
) {
  // Fetch the invocation joined with its action — verify action name matches URL param
  const [existing] = await db
    .select({
      id: actionInvocations.id,
      status: actionInvocations.status,
      actionName: actionInvocations.actionName,
      handlerAgentId: actions.handlerAgentId,
    })
    .from(actionInvocations)
    .leftJoin(actions, eq(actionInvocations.actionId, actions.id))
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!existing) return null;

  // Agent tokens must belong to the handler agent
  if (data.caller_agent_id && existing.handlerAgentId && data.caller_agent_id !== existing.handlerAgentId) {
    throw codedError('Only the handler agent can complete this invocation', 'forbidden', 403);
  }

  const status = data.error ? 'failed' : 'completed';

  const [updated] = await db
    .update(actionInvocations)
    .set({
      output: data.output ?? null,
      error: data.error ?? null,
      status,
      durationMs: data.duration_ms ?? null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
        eq(actionInvocations.status, 'invoked'),
      ),
    )
    .returning();

  // No rows updated means either not found or already completed by a concurrent request
  if (!updated) return null;

  return {
    invocation_id: updated.id,
    action_name: updated.actionName,
    caller_id: updated.callerId,
    status: updated.status,
    output: updated.output,
    error: updated.error,
    duration_ms: updated.durationMs,
    completed_at: updated.completedAt?.toISOString() ?? null,
  };
}

export async function getInvocation(db: Db, workspaceId: string, actionName: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, invocationId),
        eq(actionInvocations.actionName, actionName),
      ),
    );

  if (!row) return null;

  return {
    invocation_id: row.id,
    action_name: row.actionName,
    caller_id: row.callerId,
    caller_name: row.callerName,
    input: row.input,
    output: row.output,
    status: row.status,
    error: row.error,
    duration_ms: row.durationMs,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}
