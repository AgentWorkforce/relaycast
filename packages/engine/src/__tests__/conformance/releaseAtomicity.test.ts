import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  attachDirectNodeSocket, attachFakeBatch, createWorkspace, makeNodeStack,
  registerAgent, stripTransactionCapability, type TestStack,
} from './harness.js';
import {
  actionInvocations, agentNodeBindings, agents, channelMembers, deliveries,
  dmParticipants, nodes,
} from '../../db/schema.js';
import { completeNodeInvocation, dispatchAgentRelease } from '../../engine/action.js';
import { deleteAgent } from '../../engine/agent.js';
import { sha256Hex } from '../../lib/crypto.js';

const paths = ['delete', 'local', 'local-token', 'local-exact', 'node', 'node-token', 'node-exact'] as const;

describe('irreversible release atomicity', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  for (const path of paths) {
    for (const adapter of ['sequential', 'transaction', 'batch'] as const) {
      it(`${path} preserves identity, membership, and deliveries on ${adapter} failure`, async () => {
        const ws = await createWorkspace(stack.app, `release-${path}-${adapter}`);
        const target = await registerAgent(stack.app, ws.workspaceKey, 'target');
        const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
        const db = stack.runtime.deps.db;
        const input = {
          name: target.name,
          delete_agent: true,
          ...(path.endsWith('-token') ? { expected_token_hash: await sha256Hex(target.token) } : {}),
          ...(path.endsWith('-exact') ? { expected_agent_id: target.agentId } : {}),
        };
        let complete: (() => Promise<unknown>) | undefined;
        let invocationId: string | undefined;
        if (path.startsWith('node')) {
          const { nodeId } = await attachDirectNodeSocket(stack, ws.workspaceId, target);
          const ack = await dispatchAgentRelease(db, ws.workspaceId, { input }, {
            nodeConnections: stack.runtime.deps.nodeConnections,
          });
          expect(ack.status).toBe('dispatched');
          invocationId = ack.invocation_id;
          const [invocation] = await db.select().from(actionInvocations)
            .where(eq(actionInvocations.id, invocationId));
          complete = () => completeNodeInvocation(
            db, stack.runtime.deps.nodeConnections, ws.workspaceId, nodeId,
            invocation.dispatchedProvider!, invocation.id, { output: { released: true } },
          );
        }
        for (const text of ['must remain replayable', 'must remain acknowledgeable']) {
          const dm = await stack.app.request('/v1/dm', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${sender.token}` },
            body: JSON.stringify({ to: target.name, text }),
          });
          expect(dm.status).toBe(201);
        }
        await stack.settle();
        // Exercise both queued and delivered active rows without socket timing
        // changing the snapshot while the release is under test.
        await db.update(deliveries).set({ status: 'queued' })
          .where(eq(deliveries.agentId, target.agentId));
        const [queued] = await db.select().from(deliveries)
          .where(eq(deliveries.agentId, target.agentId));
        expect(queued).toBeDefined();
        await db.update(deliveries).set({ status: 'delivered' })
          .where(eq(deliveries.id, queued.id));

        const snapshot = async () => ({
          agent: await db.select().from(agents).where(eq(agents.id, target.agentId)),
          channels: await db.select().from(channelMembers).where(eq(channelMembers.agentId, target.agentId)),
          dms: await db.select().from(dmParticipants).where(eq(dmParticipants.agentId, target.agentId)),
          bindings: await db.select().from(agentNodeBindings).where(eq(agentNodeBindings.agentId, target.agentId)),
          nodes: await db.select().from(nodes).where(eq(nodes.workspaceId, ws.workspaceId)),
          deliveries: await db.select().from(deliveries).where(eq(deliveries.agentId, target.agentId)),
        });
        const before = await snapshot();
        expect(before.channels.length).toBeGreaterThan(0);
        expect(before.dms.length).toBeGreaterThan(0);
        expect(before.deliveries.map(row => row.status).sort()).toEqual(['delivered', 'queued']);
        if (adapter === 'sequential') stripTransactionCapability(db);
        if (adapter === 'batch') attachFakeBatch(stack, db);
        // A late tombstone failure reproduces the review's lost-message case.
        // Atomic adapters must roll back; sequential adapters must refuse first.
        stack.runtime.handle.sqlite.exec(`
          CREATE TRIGGER refuse_release_tombstone BEFORE UPDATE ON agents
          WHEN NEW.status = 'released'
          BEGIN SELECT RAISE(ABORT, 'forced tombstone failure'); END
        `);
        const release = complete ?? (() => path === 'delete'
          ? deleteAgent(db, ws.workspaceId, target.name)
          : dispatchAgentRelease(db, ws.workspaceId, { input }));
        await expect(release()).rejects.toThrow(adapter === 'sequential'
          ? /Atomic write capability required/ : /forced tombstone failure/);
        expect(await snapshot()).toEqual(before);
        if (invocationId) {
          const [invocation] = await db.select().from(actionInvocations)
            .where(eq(actionInvocations.id, invocationId));
          expect(invocation.status).toBe('dispatched');
        } else if (path !== 'delete') {
          const [invocation] = await db.select().from(actionInvocations)
            .where(eq(actionInvocations.workspaceId, ws.workspaceId));
          expect(invocation.status).toBe('pending');
        }
      });
    }
  }
});
