import { describe, expect, it } from 'vitest';
import { PresenceDO } from '../presence.js';
import type { CloudflareBindings } from '../../env.js';

class FakeStorage {
  private values = new Map<string, unknown>();
  private alarmValue: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.values.delete(item);
    }
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const prefix = options?.prefix ?? '';
    for (const [key, value] of this.values) {
      if (key.startsWith(prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmValue;
  }

  async setAlarm(value: number): Promise<void> {
    this.alarmValue = value;
  }
}

function createState(): DurableObjectState {
  return {
    storage: new FakeStorage(),
  } as unknown as DurableObjectState;
}

function createNamespace(delivered: Record<string, unknown>[]): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(name: DurableObjectId) {
      return {
        async fetch(request: Request) {
          delivered.push({
            namespaceName: name as unknown as string,
            ...((await request.json()) as Record<string, unknown>),
          });
          return Response.json({ ok: true });
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
}

function createEnv(delivered: Record<string, unknown>[]): CloudflareBindings {
  const agentNamespace = createNamespace(delivered);
  const workspaceNamespace = createNamespace([]);
  return {
    AGENT_DO: agentNamespace,
    WORKSPACE_STREAM_DO: workspaceNamespace,
    KV: {
      async get() {
        return null;
      },
    },
  } as unknown as CloudflareBindings;
}

describe('PresenceDO', () => {
  it('emits Relaycast 2.3 agent status events', async () => {
    const delivered: Record<string, unknown>[] = [];
    const object = new PresenceDO(createState(), createEnv(delivered));

    await object.fetch(new Request('http://do/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws_presence', agentId: 'agent_1', agentName: 'Alice' }),
    }));
    await object.fetch(new Request('http://do/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws_presence', agentId: 'agent_2', agentName: 'Bob' }),
    }));
    await object.fetch(new Request('http://do/disconnect', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws_presence', agentId: 'agent_1', agentName: 'Alice' }),
    }));

    expect(delivered[0]).toMatchObject({
      type: 'agent.status.active',
      status: 'active',
      agent: { name: 'Alice' },
      agent_name: 'Alice',
      subject_agent_id: 'agent_1',
      workspaceId: 'ws_presence',
      agentId: 'agent_1',
    });

    const offline = delivered.find((event) => event.type === 'agent.status.offline');
    expect(offline).toMatchObject({
      status: 'offline',
      agent: { name: 'Alice' },
      agent_name: 'Alice',
      subject_agent_id: 'agent_1',
      workspaceId: 'ws_presence',
      agentId: 'agent_2',
    });
  });
});
