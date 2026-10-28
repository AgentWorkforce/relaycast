import { and, eq, ne, not, sql } from 'drizzle-orm';
import type { EngineDb } from '../ports/database.js';
import type { AdmissionHooks, RegistrationAdmissionAction } from '../ports/admission.js';
import type { Workspace } from '../ports/auth.js';
import { agents, nodes, workspaces } from '../db/schema.js';
import { AdmissionDeniedError } from '../lib/admissionError.js';
import { WEBHOOK_AGENT_NAME } from './messageMetadata.js';

/**
 * How many of `action`'s kind the workspace currently has registered — the
 * `registered` count a registration is admitted against.
 *
 * - `register_device`: every node a host enrolled, whatever its role or
 *   transport. Every agent also owns an implicit direct node
 *   (`node_direct_<agent id>`) for its own WebSocket; those are not devices.
 *   The prefix is reserved at enrollment (`createNodeToken`), so a host cannot
 *   enroll into it.
 * - `register_agent`: non-human identities that have not been released, except
 *   the engine-provisioned inbound-webhook identity ({@link WEBHOOK_AGENT_NAME}).
 *   `createWebhook` provisions it on a workspace's first webhook; no caller
 *   registers it, and its name is reserved at registration
 *   (`assertRegistrableAgentName`), so it never holds a slot.
 * - `register_human`: `type = 'human'` identities that have not been released.
 */
export async function countRegistrations(
  db: EngineDb,
  workspaceId: string,
  action: RegistrationAdmissionAction,
): Promise<number> {
  const count = sql<number>`count(*)`;
  const rows = action === 'register_device'
    ? await db
      .select({ count })
      .from(nodes)
      .where(and(
        eq(nodes.workspaceId, workspaceId),
        // GLOB, not LIKE: in LIKE `_` is a wildcard, so `nodeXdirectX…` would
        // slip out of the count while passing the literal reserved-prefix check.
        not(and(eq(nodes.role, 'direct'), sql`${nodes.id} GLOB 'node_direct_*'`)!),
      ))
    : await db
      .select({ count })
      .from(agents)
      .where(and(
        eq(agents.workspaceId, workspaceId),
        // Tombstoned identities (`RELEASED_AGENT_STATUS` in agent.ts) hold no slot.
        ne(agents.status, 'released'),
        action === 'register_human'
          ? eq(agents.type, 'human')
          : and(ne(agents.type, 'human'), ne(agents.name, WEBHOOK_AGENT_NAME)),
      ));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Admits a NEW registration through the host's `admit` hook, throwing
 * {@link AdmissionDeniedError} on a denial. Callers invoke it only on the
 * create path — re-registering an existing node or agent is never new.
 */
export type RegistrationAdmission = (action: RegistrationAdmissionAction) => Promise<void>;

export interface RegistrationAdmissionArgs {
  db: EngineDb;
  admission: AdmissionHooks | undefined;
  /** The authenticated workspace row, or its id when the caller only has that. */
  workspace: Workspace | string;
}

async function resolveWorkspace(db: EngineDb, workspace: Workspace | string): Promise<Workspace | null> {
  if (typeof workspace !== 'string') return workspace;
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace));
  return row ?? null;
}

/**
 * Build the admission check the registration paths run before inserting a
 * node or agent, or `undefined` when the host has no `admit` hook (nothing to
 * count for). A hook or count that throws admits the registration, like every
 * other admission: a host's metering outage must not block registration.
 */
export function createRegistrationAdmission(args: RegistrationAdmissionArgs): RegistrationAdmission | undefined {
  const admit = args.admission?.admit;
  if (!admit) return undefined;
  return async (action) => {
    let denial;
    try {
      const workspace = await resolveWorkspace(args.db, args.workspace);
      if (!workspace) return;
      const registered = await countRegistrations(args.db, workspace.id, action);
      denial = await admit.call(args.admission, { workspace, action, registered });
    } catch (err) {
      console.warn('[admission] registration admission failed; admitting', {
        action,
        workspaceId: typeof args.workspace === 'string' ? args.workspace : args.workspace.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (denial) throw new AdmissionDeniedError(denial);
  };
}
