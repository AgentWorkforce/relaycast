import { and, eq, ne, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agentIdentityAudit, agentRecoveryCredentials, agents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { runAtomicWrites } from '../ports/database.js';
import { generateId } from './snowflake.js';
import { AGENT_TOKEN_GRACE_MS } from './tokenRotate.js';
import { RELEASED_AGENT_STATUS } from './agent.js';

type Db = ReturnType<typeof getDb>;

export type AgentIdentityAuthority =
  | 'current_agent_token'
  | 'origin_node'
  | 'work_unit_proof'
  | 'workspace_admin';

export interface AgentIdentityTarget {
  workspaceId: string;
  agentId: string;
  agentName: string;
}

export interface AgentIdentityAuditContext {
  authority: AgentIdentityAuthority;
  actor: string;
  reason: string;
  sessionRef?: string | null;
  nodeId?: string | null;
  originActor: string;
}

function targetPredicate(target: AgentIdentityTarget) {
  return and(
    eq(agents.workspaceId, target.workspaceId),
    eq(agents.id, target.agentId),
    eq(agents.name, target.agentName),
    ne(agents.status, RELEASED_AGENT_STATUS),
  );
}

function auditInsertAfterTokenChange(
  writeDb: Db,
  target: AgentIdentityTarget,
  tokenHash: string,
  row: typeof agentIdentityAudit.$inferInsert,
) {
  // The SELECT sees the token update earlier in the same transaction/batch.
  // If the target predicate matched no live agent, it produces no row, so D1
  // cannot commit a successful-looking audit entry for a failed mutation.
  return writeDb.insert(agentIdentityAudit).select(
    writeDb
      .select({
        id: sql<string>`${row.id}`.as('id'),
        workspaceId: sql<string>`${row.workspaceId}`.as('workspace_id'),
        agentId: sql<string>`${row.agentId}`.as('agent_id'),
        agentName: sql<string>`${row.agentName}`.as('agent_name'),
        action: sql<string>`${row.action}`.as('action'),
        authority: sql<string>`${row.authority}`.as('authority'),
        actor: sql<string>`${row.actor}`.as('actor'),
        reason: sql<string>`${row.reason}`.as('reason'),
        sessionRef: sql<string | null>`${row.sessionRef ?? null}`.as('session_ref'),
        nodeId: sql<string | null>`${row.nodeId ?? null}`.as('node_id'),
        originActor: sql<string>`${row.originActor}`.as('origin_actor'),
        createdAt: sql<Date>`unixepoch()`.as('created_at'),
      })
      .from(agents)
      .where(and(targetPredicate(target), eq(agents.tokenHash, tokenHash))),
  );
}

function firstReturnedRow<T>(result: unknown): T | undefined {
  return Array.isArray(result) ? result[0] as T | undefined : undefined;
}

export async function getRecoveryCredentialByProof(
  db: Db,
  rawProof: string,
): Promise<{
  workspaceId: string;
  agentId: string;
  agentName: string;
  workUnitId: string | null;
} | null> {
  const verifierHash = await sha256Hex(rawProof);
  const [row] = await db
    .select({
      workspaceId: agentRecoveryCredentials.workspaceId,
      agentId: agentRecoveryCredentials.agentId,
      agentName: agents.name,
      workUnitId: agentRecoveryCredentials.workUnitId,
    })
    .from(agentRecoveryCredentials)
    .innerJoin(agents, and(
      eq(agents.workspaceId, agentRecoveryCredentials.workspaceId),
      eq(agents.id, agentRecoveryCredentials.agentId),
    ))
    .where(eq(agentRecoveryCredentials.verifierHash, verifierHash));
  return row ?? null;
}

export async function enrollRecoveryCredential(
  db: Db,
  target: Pick<AgentIdentityTarget, 'workspaceId' | 'agentId'>,
  input: {
    verifierHash: string;
    proofKind?: 'work_unit';
    workUnitId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db
    .insert(agentRecoveryCredentials)
    .values({
      id: `arc_${generateId()}`,
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      proofKind: input.proofKind ?? 'work_unit',
      verifierHash: input.verifierHash,
      workUnitId: input.workUnitId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentRecoveryCredentials.workspaceId, agentRecoveryCredentials.agentId],
      set: {
        proofKind: input.proofKind ?? 'work_unit',
        verifierHash: input.verifierHash,
        workUnitId: input.workUnitId ?? null,
        updatedAt: now,
      },
    });
}

export async function rotateAgentIdentity(
  db: Db,
  target: AgentIdentityTarget,
  audit: AgentIdentityAuditContext,
  action: 'recover' | 'takeover' = 'recover',
  options: { requireAtomic?: boolean; alreadyAtomic?: boolean } = {},
): Promise<{ agent_id: string; name: string; token: string; audit_id: string }> {
  const token = `at_live_${randomHex(16)}`;
  const tokenHash = await sha256Hex(token);
  const auditId = `aid_${generateId()}`;
  const graceExpiresAtSeconds = Math.floor((Date.now() + AGENT_TOKEN_GRACE_MS) / 1000);

  const buildWrites = (writeDb: Db) => [
    writeDb
      .update(agents)
      .set({
        previousTokenHash: sql`${agents.tokenHash}`,
        previousTokenExpiresAt: sql`${graceExpiresAtSeconds}`,
        tokenHash,
      })
      .where(targetPredicate(target))
      .returning({ id: agents.id }),
    auditInsertAfterTokenChange(writeDb, target, tokenHash, {
      id: auditId,
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      agentName: target.agentName,
      action,
      authority: audit.authority,
      actor: audit.actor,
      reason: audit.reason,
      sessionRef: audit.sessionRef ?? null,
      nodeId: audit.nodeId ?? null,
      originActor: audit.originActor,
    }),
  ] as const;
  let results: unknown[];
  if (options.alreadyAtomic) {
    results = [];
    for (const write of buildWrites(db)) results.push(await write);
  } else {
    results = await runAtomicWrites(db, buildWrites, {
      requireAtomic: options.requireAtomic ?? true,
    });
  }

  if (!firstReturnedRow<{ id: string }>(results[0])) {
    throw codedError(
      `Agent "${target.agentName}" changed before identity recovery completed`,
      'agent_identity_conflict',
      409,
    );
  }

  return { agent_id: target.agentId, name: target.agentName, token, audit_id: auditId };
}

export async function takeOverAgentIdentity(
  db: Db,
  target: AgentIdentityTarget,
  audit: Omit<AgentIdentityAuditContext, 'authority'>,
): Promise<{ agent_id: string; name: string; token: string; audit_id: string }> {
  return rotateAgentIdentity(db, target, {
    ...audit,
    authority: 'workspace_admin',
  }, 'takeover');
}

export async function revokeAgentIdentityTokens(
  db: Db,
  target: AgentIdentityTarget,
  audit: Omit<AgentIdentityAuditContext, 'authority'>,
): Promise<{ agent_id: string; name: string; audit_id: string }> {
  const replacementHash = await sha256Hex(`revoked:${target.agentId}:${randomHex(16)}`);
  const auditId = `aid_${generateId()}`;
  const results = await runAtomicWrites(db, (writeDb) => [
    writeDb
      .update(agents)
      .set({
        tokenHash: replacementHash,
        previousTokenHash: null,
        previousTokenExpiresAt: null,
      })
      .where(targetPredicate(target))
      .returning({ id: agents.id }),
    auditInsertAfterTokenChange(writeDb, target, replacementHash, {
      id: auditId,
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      agentName: target.agentName,
      action: 'revoke',
      authority: 'workspace_admin',
      actor: audit.actor,
      reason: audit.reason,
      sessionRef: audit.sessionRef ?? null,
      nodeId: audit.nodeId ?? null,
      originActor: audit.originActor,
    }),
  ], { requireAtomic: true });

  if (!firstReturnedRow<{ id: string }>(results[0])) {
    throw codedError(
      `Agent "${target.agentName}" changed before revocation completed`,
      'agent_identity_conflict',
      409,
    );
  }
  return { agent_id: target.agentId, name: target.agentName, audit_id: auditId };
}
