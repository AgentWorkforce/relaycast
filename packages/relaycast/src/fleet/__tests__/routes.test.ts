import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CloudflareBindings } from '../../env.js';
import { handleFleetGatewayRequest } from '../routes.js';
import { sha256Hex } from '../crypto.js';

type NodeRecord = {
  id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  capabilities: string;
  max_agents: number;
  active_agents: number;
  tags: string;
  version: string;
  status: string;
  handlers_live: number;
  load: number;
  last_heartbeat_at: number | null;
  created_at: number;
};

type WorkspaceRecord = {
  id: string;
  name: string;
  api_key_hash: string;
};

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.db.first(this.sql, this.args) as T | null);
  }

  all<T>() {
    return Promise.resolve({ results: this.db.all(this.sql, this.args) as T[] });
  }

  run() {
    this.db.run(this.sql, this.args);
    return Promise.resolve({ success: true });
  }
}

class FakeD1 {
  readonly nodes = new Map<string, NodeRecord>();
  readonly workspaces = new Map<string, WorkspaceRecord>();

  constructor(
    workspaceId: string,
    workspaceKeyHash: string,
  ) {
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      name: 'Test workspace',
      api_key_hash: workspaceKeyHash,
    });
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, args: unknown[]) {
    if (sql.includes('FROM workspaces WHERE api_key_hash')) {
      return [...this.workspaces.values()].find((workspace) => workspace.api_key_hash === args[0]) ?? null;
    }
    if (sql.includes('FROM workspaces WHERE id = ?')) {
      return this.workspaces.get(String(args[0])) ?? null;
    }
    if (sql.includes('FROM nodes WHERE workspace_id = ? AND name = ?')) {
      return [...this.nodes.values()].find((node) => node.workspace_id === args[0] && node.name === args[1]) ?? null;
    }
    if (sql.includes('FROM nodes WHERE id = ?')) {
      return this.nodes.get(String(args[0])) ?? null;
    }
    if (sql.includes('FROM nodes WHERE token_hash = ?')) {
      return [...this.nodes.values()].find((node) => node.token_hash === args[0]) ?? null;
    }
    return null;
  }

  all(sql: string, args: unknown[]) {
    if (sql.includes('FROM nodes WHERE workspace_id = ?')) {
      return [...this.nodes.values()]
        .filter((node) => node.workspace_id === args[0])
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    return [];
  }

  run(sql: string, args: unknown[]) {
    if (sql.includes('INSERT INTO nodes')) {
      const [
        id,
        workspaceId,
        name,
        tokenHash,
        capabilities,
        maxAgents,
        tags,
        version,
        createdAt,
      ] = args;
      this.nodes.set(String(id), {
        id: String(id),
        workspace_id: String(workspaceId),
        name: String(name),
        token_hash: String(tokenHash),
        capabilities: String(capabilities),
        max_agents: Number(maxAgents),
        active_agents: 0,
        tags: String(tags),
        version: String(version),
        status: 'offline',
        handlers_live: 0,
        load: 0,
        last_heartbeat_at: null,
        created_at: Number(createdAt),
      });
      return;
    }

    if (sql.includes('UPDATE nodes')) {
      const [tokenHash, capabilities, maxAgents, tags, version, id] = args;
      const node = this.nodes.get(String(id));
      if (!node) return;
      Object.assign(node, {
        token_hash: String(tokenHash),
        capabilities: String(capabilities),
        max_agents: Number(maxAgents),
        tags: String(tags),
        version: String(version),
        status: 'offline',
        handlers_live: 0,
        load: 0,
        active_agents: 0,
      });
      return;
    }

    if (sql.includes("UPDATE workspaces SET api_key_hash")) {
      const [apiKeyHash, workspaceId] = args;
      const workspace = this.workspaces.get(String(workspaceId));
      if (!workspace) return;
      workspace.api_key_hash = String(apiKeyHash);
    }
  }
}

function realRelaycastWorkspaceColumns(): Set<string> {
  const migration = readFileSync(new URL('../../db/migrations/0000_broad_dagger.sql', import.meta.url), 'utf8');
  const match = /CREATE TABLE `workspaces` \(([\s\S]*?)\);/.exec(migration);
  if (!match) throw new Error('Could not find workspaces table migration');
  const columns = new Set<string>();
  for (const line of match[1]!.split('\n')) {
    const column = /^\s*`([^`]+)`/.exec(line)?.[1];
    if (column) columns.add(column);
  }
  return columns;
}

class SchemaCheckingD1 extends FakeD1 {
  constructor(
    workspaceId: string,
    workspaceKeyHash: string,
    private readonly workspaceColumns: Set<string>,
  ) {
    super(workspaceId, workspaceKeyHash);
  }

  run(sql: string, args: unknown[]) {
    const update = /^UPDATE\s+workspaces\s+SET\s+(.+?)\s+WHERE\s+/i.exec(sql.replace(/\s+/g, ' '));
    if (update) {
      for (const assignment of update[1]!.split(',')) {
        const column = assignment.split('=')[0]!.trim().replace(/`/g, '');
        if (!this.workspaceColumns.has(column)) {
          throw new Error(`Column ${column} is not present in Relaycast workspaces schema`);
        }
      }
    }
    return super.run(sql, args);
  }
}

describe('fleet gateway node routes', () => {
  it('mints a node token and lists public roster fields', async () => {
    const workspaceKey = 'rk_live_test_workspace';
    const fakeDb = new FakeD1('rw_test', await sha256Hex(workspaceKey));
    const env = { DB: fakeDb } as unknown as CloudflareBindings;

    const createResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/nodes', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workspaceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          node_id: 'node_test',
          name: 'daytona-a',
          capabilities: ['spawn', { name: 'github.pr.review', kind: 'action' }],
          max_agents: 8,
          tags: ['daytona'],
          version: 'test-version',
        }),
      }),
      env,
    );

    expect(createResponse?.status).toBe(201);
    const created = await createResponse!.json() as { ok: boolean; data: Record<string, unknown> };
    expect(created.ok).toBe(true);
    expect(String(created.data.token)).toMatch(/^nt_live_/);
    expect(created.data).toMatchObject({
      id: 'node_test',
      name: 'daytona-a',
      status: 'offline',
      live: false,
      handlers_live: false,
      load: 0,
      active_agents: 0,
      max_agents: 8,
    });

    const listResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/nodes', {
        headers: { authorization: `Bearer ${workspaceKey}` },
      }),
      env,
    );

    expect(listResponse?.status).toBe(200);
    const listed = await listResponse!.json() as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(listed.ok).toBe(true);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.capabilities).toEqual([{ name: 'spawn' }, { name: 'github.pr.review', kind: 'action' }]);
    expect(listed.data[0]?.tags).toEqual(['daytona']);
  });

  async function mintNode(): Promise<{ env: CloudflareBindings; token: string; forwarded: Request[] }> {
    const workspaceKey = 'rk_live_test_workspace';
    const fakeDb = new FakeD1('rw_test', await sha256Hex(workspaceKey));
    const forwarded: Request[] = [];
    const fakeNodeDo = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (req: Request) => {
          forwarded.push(req);
          // The real DO returns a 101 upgrade; undici's Response (used by the
          // test runner) rejects status 101, so use a 200 sentinel to assert
          // the upgrade authenticated and forwarded to the DO.
          return Promise.resolve(new Response('upgraded', { status: 200 }));
        },
      }),
    };
    const env = { DB: fakeDb, NODE_DO: fakeNodeDo } as unknown as CloudflareBindings;

    const createResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/nodes', {
        method: 'POST',
        headers: { authorization: `Bearer ${workspaceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ node_id: 'node_test', name: 'daytona-a', capabilities: ['spawn'], max_agents: 8 }),
      }),
      env,
    );
    const created = await createResponse!.json() as { data: { token: string } };
    return { env, token: created.data.token, forwarded };
  }

  it('authenticates a node-WS upgrade carrying the token in the Authorization: Bearer header', async () => {
    const { env, token, forwarded } = await mintNode();

    const response = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/node/ws', {
        headers: { authorization: `Bearer ${token}`, upgrade: 'websocket' },
      }),
      env,
    );

    expect(response?.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    const forwardedUrl = new URL(forwarded[0]!.url);
    expect(forwardedUrl.pathname).toBe('/ws');
    expect(forwardedUrl.searchParams.get('node_id')).toBe('node_test');
    expect(forwardedUrl.searchParams.get('workspace_id')).toBe('rw_test');
    // The credential must not leak past the auth boundary into the DO.
    expect(forwardedUrl.searchParams.get('token')).toBeNull();
  });

  it('still authenticates a node-WS upgrade carrying the token in the ?token= query (SDK/Pear back-compat)', async () => {
    const { env, token, forwarded } = await mintNode();

    const response = await handleFleetGatewayRequest(
      new Request(`https://relay.test/v1/node/ws?token=${encodeURIComponent(token)}`, {
        headers: { upgrade: 'websocket' },
      }),
      env,
    );

    expect(response?.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0]!.url).searchParams.get('token')).toBeNull();
  });

  it('rejects a node-WS upgrade with no token', async () => {
    const { env } = await mintNode();

    const response = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/node/ws', { headers: { upgrade: 'websocket' } }),
      env,
    );

    expect(response?.status).toBe(401);
  });

  it('re-registers an existing workspace API key without changing workspace identity', async () => {
    const workspaceKey = 'rk_live_test_workspace';
    const fakeDb = new FakeD1('rw_test', await sha256Hex('rk_live_wrong_gateway_key'));
    const env = {
      DB: fakeDb,
      RELAYCAST_INTERNAL_SECRET: 'internal-secret',
    } as unknown as CloudflareBindings;

    const oldKeyResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/nodes', {
        headers: { authorization: `Bearer ${workspaceKey}` },
      }),
      env,
    );
    expect(oldKeyResponse?.status).toBe(401);

    const ensureResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/internal/workspaces/rw_test/api-key', {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: workspaceKey }),
      }),
      env,
    );

    expect(ensureResponse?.status).toBe(200);
    const ensured = await ensureResponse!.json() as { ok: boolean; data: { workspace_id: string } };
    expect(ensured.ok).toBe(true);
    expect(ensured.data.workspace_id).toBe('rw_test');

    const repairedKeyResponse = await handleFleetGatewayRequest(
      new Request('https://relay.test/v1/nodes', {
        headers: { authorization: `Bearer ${workspaceKey}` },
      }),
      env,
    );
    expect(repairedKeyResponse?.status).toBe(200);
  });

  it('requires the internal secret before re-registering a workspace API key', async () => {
    const fakeDb = new FakeD1('rw_test', await sha256Hex('rk_live_test_workspace'));
    const env = {
      DB: fakeDb,
      RELAYCAST_INTERNAL_SECRET: 'internal-secret',
    } as unknown as CloudflareBindings;

    const missingAuth = await handleFleetGatewayRequest(
      new Request('https://relay.test/internal/workspaces/rw_test/api-key', {
        method: 'POST',
        body: JSON.stringify({ api_key: 'rk_live_test_workspace' }),
      }),
      env,
    );
    expect(missingAuth?.status).toBe(401);

    const wrongAuth = await handleFleetGatewayRequest(
      new Request('https://relay.test/internal/workspaces/rw_test/api-key', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: 'rk_live_test_workspace' }),
      }),
      env,
    );
    expect(wrongAuth?.status).toBe(401);

    const unconfigured = await handleFleetGatewayRequest(
      new Request('https://relay.test/internal/workspaces/rw_test/api-key', {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: 'rk_live_test_workspace' }),
      }),
      { DB: fakeDb, RELAYCAST_INTERNAL_SECRET: 'unset' } as unknown as CloudflareBindings,
    );
    expect(unconfigured?.status).toBe(503);
  });

  it('re-registers a workspace key using only columns from the real Relaycast workspaces schema', async () => {
    const fakeDb = new SchemaCheckingD1(
      'rw_schema',
      await sha256Hex('rk_live_wrong_gateway_key'),
      realRelaycastWorkspaceColumns(),
    );

    const response = await handleFleetGatewayRequest(
      new Request('https://relay.test/internal/workspaces/rw_schema/api-key', {
        method: 'POST',
        headers: { authorization: 'Bearer internal-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: 'rk_live_schema_key' }),
      }),
      {
        DB: fakeDb,
        RELAYCAST_INTERNAL_SECRET: 'internal-secret',
      } as unknown as CloudflareBindings,
    );

    expect(response?.status).toBe(200);
    expect(fakeDb.workspaces.get('rw_schema')?.api_key_hash).toBe(await sha256Hex('rk_live_schema_key'));
  });
});
