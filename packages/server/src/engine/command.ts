import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { commands, agents, messages, channels } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export async function registerCommand(
  db: Db,
  workspaceId: string,
  data: {
    command: string;
    description: string;
    handler_agent: string;
    parameters?: Array<{
      name: string;
      description?: string;
      type: string;
      required?: boolean;
    }>;
  },
) {
  // Look up handler agent by name
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.handler_agent)),
    );

  if (!agent) {
    const err = new Error(`Agent "${data.handler_agent}" not found`) as Error & { status: number; code: string };
    err.status = 404;
    err.code = 'agent_not_found';
    throw err;
  }

  const id = `cmd_${generateId()}`;
  // Normalize command name: strip leading slash if present
  const commandName = data.command.startsWith('/')
    ? data.command.slice(1)
    : data.command;

  const [cmd] = await db
    .insert(commands)
    .values({
      id,
      workspaceId,
      command: commandName,
      description: data.description,
      handlerAgentId: agent.id,
      parameters: data.parameters || [],
    })
    .returning();

  return {
    id: cmd.id,
    command: `/${cmd.command}`,
    description: cmd.description,
    handler_agent: data.handler_agent,
    parameters: cmd.parameters || [],
    created_at: cmd.createdAt.toISOString(),
  };
}

export async function listCommands(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      id: commands.id,
      command: commands.command,
      description: commands.description,
      handlerAgentId: commands.handlerAgentId,
      handlerAgentName: agents.name,
      parameters: commands.parameters,
      isActive: commands.isActive,
      createdAt: commands.createdAt,
    })
    .from(commands)
    .innerJoin(agents, eq(commands.handlerAgentId, agents.id))
    .where(eq(commands.workspaceId, workspaceId));

  return rows.map((r) => ({
    id: r.id,
    command: `/${r.command}`,
    description: r.description,
    handler_agent: r.handlerAgentName,
    parameters: r.parameters || [],
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getCommand(db: Db, workspaceId: string, commandName: string) {
  const name = commandName.startsWith('/') ? commandName.slice(1) : commandName;

  const [row] = await db
    .select({
      id: commands.id,
      command: commands.command,
      description: commands.description,
      handlerAgentId: commands.handlerAgentId,
      handlerAgentName: agents.name,
      parameters: commands.parameters,
      isActive: commands.isActive,
      createdAt: commands.createdAt,
    })
    .from(commands)
    .innerJoin(agents, eq(commands.handlerAgentId, agents.id))
    .where(
      and(eq(commands.workspaceId, workspaceId), eq(commands.command, name)),
    );

  if (!row) return null;

  return {
    id: row.id,
    command: `/${row.command}`,
    description: row.description,
    handler_agent: row.handlerAgentName,
    parameters: row.parameters || [],
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function deleteCommand(db: Db, workspaceId: string, commandName: string) {
  const name = commandName.startsWith('/') ? commandName.slice(1) : commandName;

  const result = await db
    .delete(commands)
    .where(
      and(eq(commands.workspaceId, workspaceId), eq(commands.command, name)),
    )
    .returning();

  return result.length > 0;
}

export async function invokeCommand(
  db: Db,
  workspaceId: string,
  commandName: string,
  data: {
    channel: string;
    invoked_by: string;
    args?: string;
    parameters?: Record<string, unknown>;
  },
) {
  const name = commandName.startsWith('/') ? commandName.slice(1) : commandName;

  // Look up command
  const [cmd] = await db
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.workspaceId, workspaceId),
        eq(commands.command, name),
        eq(commands.isActive, true),
      ),
    );

  if (!cmd) {
    const err = new Error(`Command "/${name}" not found`) as Error & { status: number; code: string };
    err.status = 404;
    err.code = 'command_not_found';
    throw err;
  }

  // Look up the channel
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, data.channel)),
    );

  if (!channel) {
    const err = new Error(`Channel "${data.channel}" not found`) as Error & { status: number; code: string };
    err.status = 404;
    err.code = 'channel_not_found';
    throw err;
  }

  // Post a structured command message to the channel
  const messageId = generateId();
  const messageBody = data.args
    ? `/${name} ${data.args}`
    : `/${name}`;

  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      channelId: channel.id,
      agentId: data.invoked_by,
      body: messageBody,
    })
    .returning();

  return {
    id: messageId,
    command: `/${name}`,
    channel: data.channel,
    invoked_by: data.invoked_by,
    args: data.args || null,
    parameters: data.parameters || null,
    handler_agent_id: cmd.handlerAgentId,
    message_id: message.id,
    created_at: message.createdAt.toISOString(),
  };
}
