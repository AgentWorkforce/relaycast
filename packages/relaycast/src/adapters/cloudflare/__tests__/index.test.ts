import { describe, expect, it } from 'vitest';
import { createCloudflareEngineDeps } from '../index.js';
import type { CloudflareBindings } from '../../../env.js';

function createEnv(kvValues: Record<string, string> = {}): CloudflareBindings {
  const values = new Map(Object.entries(kvValues));
  const durableObjectNamespace = {} as DurableObjectNamespace;

  return {
    DB: {} as D1Database,
    FILES_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: {} as Queue,
    NOTIFICATION_QUEUE: {} as Queue,
    CHANNEL_DO: durableObjectNamespace,
    AGENT_DO: durableObjectNamespace,
    PRESENCE_DO: durableObjectNamespace,
    WORKSPACE_STREAM_DO: durableObjectNamespace,
    RATE_LIMIT_DO: durableObjectNamespace,
    KV: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    } as KVNamespace,
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    CF_ACCOUNT_ID: 'test-account',
    ENVIRONMENT: 'test',
  };
}

describe('createCloudflareEngineDeps', () => {
  it('passes KV state through to the engine for workspace-stream flag reads', async () => {
    const deps = createCloudflareEngineDeps(createEnv({
      'workspace-stream:ws_enabled': 'true',
    }));

    // workspaceStreamEnabled is KV-driven in 5.x — not a static EngineConfig field.
    expect(deps.config?.workspaceStreamEnabled).toBeUndefined();
    await expect(deps.kv.get('workspace-stream:ws_enabled')).resolves.toBe('true');
  });
});

