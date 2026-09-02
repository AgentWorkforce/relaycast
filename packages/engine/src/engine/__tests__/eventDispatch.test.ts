import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_DELIVER_FRAME_EVENT_TYPES, type FleetRelaycastToBrokerMessage } from '@relaycast/types';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import {
  agentNodeBindings,
  agents,
  channelMembers,
  channels,
  nodes,
  workspaces,
} from '../../db/schema.js';
import { publishEvent, publishEventsToAgents, type EventDispatchEngine } from '../eventDispatch.js';


// The workspace-log append swallows its own DB errors today, so the only way to
// exercise the dispatcher's handling of a rejected append task is to make the
// append itself reject.
const workspaceLog = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('../workspaceEvents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspaceEvents.js')>();
  return {
    ...actual,
    appendAndPublishWorkspaceEvent: async (
      ...args: Parameters<typeof actual.appendAndPublishWorkspaceEvent>
    ) => {
      if (workspaceLog.failure) throw workspaceLog.failure;
      return actual.appendAndPublishWorkspaceEvent(...args);
    },
    appendAndPublishWorkspaceEventBatch: async (
      ...args: Parameters<typeof actual.appendAndPublishWorkspaceEventBatch>
    ) => {
      if (workspaceLog.failure) throw workspaceLog.failure;
      return actual.appendAndPublishWorkspaceEventBatch(...args);
    },
  };
});

const WORKSPACE_ID = 'ws_dispatch';
const CHANNEL_ID = 'ch_dispatch';
const AGENT_ID = 'ag_dispatch';
const NODE_ID = 'node_dispatch';
const SECOND_AGENT_ID = 'ag_dispatch_2';
const SECOND_NODE_ID = 'node_dispatch_2';

type ContextFrame = {
  workspaceId: string;
  nodeId: string;
  providerName: string;
  message: FleetRelaycastToBrokerMessage;
};

const handles: SqliteDbHandle[] = [];

afterEach(() => {
  workspaceLog.failure = null;
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

async function seedFixture() {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  handles.push(handle);
  const { db } = handle;

  await db.insert(workspaces).values({ id: WORKSPACE_ID, name: 'dispatch', apiKeyHash: 'hash_ws' });
  await db.insert(nodes).values({
    id: NODE_ID,
    workspaceId: WORKSPACE_ID,
    name: 'dispatch-node',
    tokenHash: 'hash_node',
    kind: 'ws',
    role: 'broker',
    deliveryAdapter: 'ws.node.v1',
    status: 'online',
  });
  await db.insert(agents).values({
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'dispatch-agent',
    tokenHash: 'hash_agent',
    locationType: 'via_node',
    locationNodeId: NODE_ID,
    providerName: 'default',
  });
  await db.insert(agentNodeBindings).values({
    id: 'bind_dispatch',
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    nodeId: NODE_ID,
    status: 'active',
  });
  await db.insert(channels).values({ id: CHANNEL_ID, workspaceId: WORKSPACE_ID, name: 'general' });
  await db.insert(channelMembers).values({ channelId: CHANNEL_ID, agentId: AGENT_ID });

  return db;
}

/** Add a second node hosting a second member of the same channel. */
async function seedSecondNode(db: Awaited<ReturnType<typeof seedFixture>>) {
  await db.insert(nodes).values({
    id: SECOND_NODE_ID,
    workspaceId: WORKSPACE_ID,
    name: 'dispatch-node-2',
    tokenHash: 'hash_node_2',
    kind: 'ws',
    role: 'broker',
    deliveryAdapter: 'ws.node.v1',
    status: 'online',
  });
  await db.insert(agents).values({
    id: SECOND_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'dispatch-agent-2',
    tokenHash: 'hash_agent_2',
    locationType: 'via_node',
    locationNodeId: SECOND_NODE_ID,
    providerName: 'default',
  });
  await db.insert(agentNodeBindings).values({
    id: 'bind_dispatch_2',
    workspaceId: WORKSPACE_ID,
    agentId: SECOND_AGENT_ID,
    nodeId: SECOND_NODE_ID,
    status: 'active',
  });
  await db.insert(channelMembers).values({ channelId: CHANNEL_ID, agentId: SECOND_AGENT_ID });
}

function makeEngine(overrides: {
  publish?: (args: { workspaceId: string; event: Record<string, unknown> }) => Promise<void>;
  send?: (nodeId: string) => Promise<boolean>;
} = {}) {
  const published: Array<{ workspaceId: string; event: Record<string, unknown> }> = [];
  const frames: ContextFrame[] = [];
  const engine = {
    realtime: {
      publishToWorkspaceStream: async (args: { workspaceId: string; event: Record<string, unknown> }) => {
        published.push(args);
        await overrides.publish?.(args);
      },
    },
    nodeConnections: {
      sendToProvider: async (
        workspaceId: string,
        nodeId: string,
        providerName: string,
        message: FleetRelaycastToBrokerMessage,
      ) => {
        frames.push({ workspaceId, nodeId, providerName, message });
        return overrides.send ? overrides.send(nodeId) : true;
      },
    },
    config: { environment: 'test' },
  } as unknown as EventDispatchEngine;
  return { engine, published, frames };
}

function contextUpdates(frames: ContextFrame[]) {
  return frames
    .map((frame) => frame.message)
    .filter((message) => message.type === 'context.update');
}

describe('publishEvent', () => {
  it.each([...NODE_DELIVER_FRAME_EVENT_TYPES])(
    'does not push a context.update for the deliver-frame type %s',
    async (type) => {
      const db = await seedFixture();
      const { engine, published, frames } = makeEngine();

      await publishEvent({ db, engine }, {
        workspaceId: WORKSPACE_ID,
        type,
        data: { agent_id: AGENT_ID, agent_name: 'dispatch-agent' },
        scope: { kind: 'channel', channelId: CHANNEL_ID },
      });

      expect(frames).toHaveLength(0);
      // The observer stream still sees it — only the node push is suppressed.
      expect(published).toHaveLength(1);
      expect(published[0].event.type).toBe(type);
    },
  );

  it('pushes a channel-scoped context.update for a context-frame type', async () => {
    const db = await seedFixture();
    const { engine, published, frames } = makeEngine();

    await publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'member.joined',
      data: { agent_id: AGENT_ID, agent_name: 'dispatch-agent', channel_name: 'general' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
    });

    expect(published).toHaveLength(1);
    expect(contextUpdates(frames)).toEqual([
      {
        v: 1,
        type: 'context.update',
        topic: 'channel',
        event: 'member.joined',
        channel_id: CHANNEL_ID,
        agent_ids: [AGENT_ID],
        data: { agent_id: AGENT_ID, agent_name: 'dispatch-agent', channel_name: 'general' },
      },
    ]);
  });

  it('uses the thread topic for thread events', async () => {
    const db = await seedFixture();
    const { engine, frames } = makeEngine();

    await publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'thread.updated',
      data: { thread_id: 'th_1' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
    });

    expect(contextUpdates(frames).map((message) => message.topic)).toEqual(['thread']);
  });

  it('pushes an agent-scoped context.update for delivery.failed', async () => {
    const db = await seedFixture();
    const { engine, frames } = makeEngine();

    await publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'delivery.failed',
      data: { delivery_id: 'dl_1', reason: 'node_unavailable' },
      scope: { kind: 'agents', agentIds: [AGENT_ID, AGENT_ID] },
    });

    expect(contextUpdates(frames)).toEqual([
      {
        v: 1,
        type: 'context.update',
        topic: 'agent',
        event: 'delivery.failed',
        channel_id: null,
        agent_ids: [AGENT_ID],
        data: { delivery_id: 'dl_1', reason: 'node_unavailable' },
      },
    ]);
  });

  it('pushes a presence-scoped context.update for agent.status.changed', async () => {
    const db = await seedFixture();
    const { engine, frames } = makeEngine();

    await publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'agent.status.changed',
      data: { agent_id: AGENT_ID, agent_name: 'dispatch-agent', status: 'idle' },
      scope: { kind: 'presence', subjectAgentId: AGENT_ID },
    });

    const updates = contextUpdates(frames);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      topic: 'presence',
      event: 'agent.status.changed',
      agent_ids: [AGENT_ID],
    });
  });

  it('never pushes node context for a workspace-scoped event', async () => {
    const db = await seedFixture();
    const { engine, published, frames } = makeEngine();

    await publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'agent.status.changed',
      data: { agent_id: AGENT_ID, agent_name: 'dispatch-agent', status: 'idle' },
      scope: { kind: 'workspace' },
    });

    expect(frames).toHaveLength(0);
    expect(published).toHaveLength(1);
  });

  it('keeps sinks independent: a failing stream publish still pushes node context', async () => {
    const db = await seedFixture();
    const errors: Array<[string, unknown]> = [];
    const { engine, frames } = makeEngine({
      publish: async () => { throw new Error('stream down'); },
    });

    await expect(publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'member.joined',
      data: { agent_name: 'dispatch-agent' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
      onSinkError: (sink, err) => errors.push([sink, err]),
    })).resolves.toBeUndefined();

    expect(contextUpdates(frames)).toHaveLength(1);
    expect(errors.map(([sink]) => sink)).toEqual(['workspace_stream']);
  });

  it('keeps sinks independent: a failing node push still publishes to the stream', async () => {
    const db = await seedFixture();
    const errors: Array<[string, unknown]> = [];
    const { engine, published } = makeEngine({
      send: async () => { throw new Error('socket gone'); },
    });

    await expect(publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'member.joined',
      data: { agent_name: 'dispatch-agent' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
      onSinkError: (sink, err) => errors.push([sink, err]),
    })).resolves.toBeUndefined();

    expect(published).toHaveLength(1);
    // sendContextToRows settles its sends independently, then reports the batch.
    expect(errors.map(([sink]) => sink)).toEqual(['node_context']);
  });

  it('reports a rejected workspace-log append and still pushes node context', async () => {
    const db = await seedFixture();
    const errors: Array<[string, unknown]> = [];
    const { engine, frames } = makeEngine();
    workspaceLog.failure = new Error('append rejected');

    await expect(publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'member.joined',
      data: { agent_name: 'dispatch-agent' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
      onSinkError: (sink, err) => errors.push([sink, err]),
    })).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('workspace_stream');
    expect((errors[0][1] as Error).message).toBe('append rejected');
    expect(contextUpdates(frames)).toHaveLength(1);
  });

  it('delivers to the healthy node and reports node_context once when one node send fails', async () => {
    const db = await seedFixture();
    await seedSecondNode(db);
    const errors: Array<[string, unknown]> = [];
    const { engine, published, frames } = makeEngine({
      send: async (nodeId) => {
        if (nodeId === NODE_ID) throw new Error('socket gone');
        return true;
      },
    });

    await expect(publishEvent({ db, engine }, {
      workspaceId: WORKSPACE_ID,
      type: 'member.joined',
      data: { agent_name: 'dispatch-agent' },
      scope: { kind: 'channel', channelId: CHANNEL_ID },
      onSinkError: (sink, err) => errors.push([sink, err]),
    })).resolves.toBeUndefined();

    expect(published).toHaveLength(1);
    // Both nodes were attempted; the healthy one still received its frame.
    expect(frames.map((frame) => frame.nodeId).sort()).toEqual([NODE_ID, SECOND_NODE_ID]);
    expect(errors.map(([sink]) => sink)).toEqual(['node_context']);
    const reported = errors[0][1] as AggregateError;
    expect(reported).toBeInstanceOf(AggregateError);
    expect(reported.message).toBe('node context push failed for 1 of 2 node targets');
  });
});

describe('publishEventsToAgents', () => {
  it('publishes each event and pushes context-frame ones to their agent nodes', async () => {
    const db = await seedFixture();
    const { engine, published, frames } = makeEngine();

    await publishEventsToAgents({ db, engine }, [
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, type: 'delivery.failed', data: { delivery_id: 'dl_1' } },
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, type: 'delivery.failed', data: { delivery_id: 'dl_2' } },
    ]);

    expect(published.map((entry) => entry.event.type)).toEqual(['delivery.failed', 'delivery.failed']);
    expect(contextUpdates(frames).map((message) => message.event)).toEqual([
      'delivery.failed',
      'delivery.failed',
    ]);
  });

  it('suppresses the node push for deliver-frame types', async () => {
    const db = await seedFixture();
    const { engine, published, frames } = makeEngine();

    await publishEventsToAgents({ db, engine }, [
      { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, type: 'message.created', data: { id: 'msg_1' } },
    ]);

    expect(published).toHaveLength(1);
    expect(frames).toHaveLength(0);
  });

  it('reports a rejected batch workspace-log append and still pushes node context', async () => {
    const db = await seedFixture();
    const errors: Array<[string, unknown]> = [];
    const { engine, frames } = makeEngine();
    workspaceLog.failure = new Error('batch append rejected');

    await publishEventsToAgents(
      { db, engine },
      [{ workspaceId: WORKSPACE_ID, agentId: AGENT_ID, type: 'delivery.failed', data: { delivery_id: 'dl_1' } }],
      (sink, err) => errors.push([sink, err]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('workspace_stream');
    expect((errors[0][1] as Error).message).toBe('batch append rejected');
    expect(contextUpdates(frames)).toHaveLength(1);
  });

  it('is a no-op for an empty batch', async () => {
    const db = await seedFixture();
    const { engine, published, frames } = makeEngine();

    await publishEventsToAgents({ db, engine }, []);

    expect(published).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});
