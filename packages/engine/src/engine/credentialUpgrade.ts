import { and, eq, gt } from 'drizzle-orm';
import { isArWorkspaceId, type CredentialKind } from '@relaycast/types';
import { agents, credentialUpgrades, nodes, observerTokens, webhooks, workspaces } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import { runAtomicWrites } from '../ports/database.js';
import { credentialFromHex, credentialTagger } from '../auth/credentials.js';
import { hmacSha256Hex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';

/** How long an upgraded legacy credential keeps working, unless configured: 30 days. */
export const DEFAULT_LEGACY_CREDENTIAL_GRACE_SECONDS = 30 * 24 * 60 * 60;

/** The column each kind of principal keeps its credential hash in. */
const PRINCIPALS = {
  workspace: { table: workspaces, id: workspaces.id, hash: workspaces.apiKeyHash },
  agent: { table: agents, id: agents.id, hash: agents.tokenHash },
  node: { table: nodes, id: nodes.id, hash: nodes.tokenHash },
  observer: { table: observerTokens, id: observerTokens.id, hash: observerTokens.tokenHash },
  webhook: { table: webhooks, id: webhooks.id, hash: webhooks.tokenHash },
} as const;

/** Swap a principal's credential hash from `from` to `to` (compare-and-set). */
function swapPrincipalHash(w: EngineDb, kind: CredentialKind, id: string, from: string, to: string) {
  switch (kind) {
    case 'workspace':
      return w.update(workspaces).set({ apiKeyHash: to }).where(and(eq(workspaces.id, id), eq(workspaces.apiKeyHash, from)));
    case 'agent':
      return w.update(agents).set({ tokenHash: to }).where(and(eq(agents.id, id), eq(agents.tokenHash, from)));
    case 'node':
      return w.update(nodes).set({ tokenHash: to }).where(and(eq(nodes.id, id), eq(nodes.tokenHash, from)));
    case 'observer':
      return w.update(observerTokens).set({ tokenHash: to }).where(and(eq(observerTokens.id, id), eq(observerTokens.tokenHash, from)));
    case 'webhook':
      return w.update(webhooks).set({ tokenHash: to }).where(and(eq(webhooks.id, id), eq(webhooks.tokenHash, from)));
  }
}

export interface UpgradedLegacyCredential {
  kind: CredentialKind;
  principalId: string;
  workspaceId: string;
  arHash: string;
}

/**
 * The principal an upgraded legacy credential (by hash) still stands for: its
 * grace has not run out, and the principal still holds the `ar_` credential
 * it was upgraded to (a later rotation or revocation ends the legacy one too).
 */
export async function upgradedLegacyCredential(
  db: EngineDb,
  kind: CredentialKind,
  legacyHash: string,
  now: Date = new Date(),
): Promise<UpgradedLegacyCredential | undefined> {
  const [row] = await db.select().from(credentialUpgrades).where(and(
    eq(credentialUpgrades.legacyHash, legacyHash),
    eq(credentialUpgrades.kind, kind),
    gt(credentialUpgrades.expiresAt, now),
  ));
  if (!row) return undefined;
  const principal = PRINCIPALS[kind];
  const [current] = await db.select({ hash: principal.hash }).from(principal.table)
    .where(eq(principal.id, row.principalId));
  if (current?.hash !== row.arHash) return undefined;
  return { kind, principalId: row.principalId, workspaceId: row.workspaceId, arHash: row.arHash };
}

/** The `ar_` credential `legacyToken` upgrades to under `tag`: deterministic, so a retry returns the same one. */
async function upgradedCredential(
  db: EngineDb,
  legacyToken: string,
  kind: CredentialKind,
  principalId: string,
  workspaceId: string,
  tag: string,
): Promise<string> {
  const digest = await hmacSha256Hex(`relaycast:credential-upgrade:v1:${kind}:${principalId}`, legacyToken);
  return credentialFromHex(db, 'ar', kind, workspaceId, digest, tag);
}

export interface CredentialUpgradeResult {
  credential: string;
  kind: CredentialKind;
  legacyExpiresAt: Date;
}

/**
 * Replace a principal's legacy credential with an `ar_` one. The principal's
 * hash column takes the `ar_` credential; the legacy one keeps authenticating
 * for `graceSeconds`. Upgrading the same legacy credential again returns the
 * same `ar_` credential. `currentHash` is the principal's stored hash, so a
 * credential that only authenticates through a rotation grace slot (already
 * superseded) is refused.
 */
export async function upgradeLegacyCredential(
  db: EngineDb,
  args: {
    legacyToken: string;
    kind: CredentialKind;
    principalId: string;
    workspaceId: string;
    currentHash: string | null;
    graceSeconds: number;
  },
): Promise<CredentialUpgradeResult> {
  const { legacyToken, kind, principalId, workspaceId } = args;
  const tagger = credentialTagger(db);
  if (!tagger || !isArWorkspaceId(workspaceId)) {
    throw codedError('This deployment does not issue ar_ credentials', 'credential_upgrade_unavailable', 409);
  }
  const superseded = () => codedError(
    'This credential was superseded; upgrade with the principal\'s current credential',
    'credential_superseded',
    409,
  );
  const legacyHash = await sha256Hex(legacyToken);
  const now = new Date();

  const [existing] = await db.select().from(credentialUpgrades).where(and(
    eq(credentialUpgrades.legacyHash, legacyHash),
    gt(credentialUpgrades.expiresAt, now),
  ));
  if (existing) {
    if (args.currentHash !== existing.arHash) throw superseded();
    for (const tag of await tagger.tags(workspaceId)) {
      const credential = await upgradedCredential(db, legacyToken, kind, principalId, workspaceId, tag);
      if (await sha256Hex(credential) === existing.arHash) {
        return { credential, kind, legacyExpiresAt: existing.expiresAt };
      }
    }
    throw superseded();
  }
  if (args.currentHash !== legacyHash) throw superseded();

  const credential = await upgradedCredential(db, legacyToken, kind, principalId, workspaceId, await tagger.tag(workspaceId));
  const arHash = await sha256Hex(credential);
  const legacyExpiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + args.graceSeconds * 1000);
  const principal = PRINCIPALS[kind];
  await runAtomicWrites(db, (w) => [
    w.insert(credentialUpgrades)
      .values({ legacyHash, kind, principalId, workspaceId, arHash, expiresAt: legacyExpiresAt })
      .onConflictDoUpdate({ target: credentialUpgrades.legacyHash, set: { kind, principalId, workspaceId, arHash, expiresAt: legacyExpiresAt, createdAt: now } }),
    swapPrincipalHash(w, kind, principalId, legacyHash, arHash),
  ], { requireAtomic: true });

  // The compare-and-set loses to a rotation that landed in between.
  const [current] = await db.select({ hash: principal.hash }).from(principal.table).where(eq(principal.id, principalId));
  if (current?.hash !== arHash) throw superseded();
  return { credential, kind, legacyExpiresAt };
}

/** The inbound webhook whose current or upgraded legacy token is `token`. */
export async function webhookForToken(
  db: EngineDb,
  token: string,
): Promise<{ id: string; workspaceId: string; tokenHash: string | null } | undefined> {
  const hash = await sha256Hex(token);
  const [webhook] = await db.select({ id: webhooks.id, workspaceId: webhooks.workspaceId, tokenHash: webhooks.tokenHash })
    .from(webhooks).where(and(eq(webhooks.tokenHash, hash), eq(webhooks.isActive, true)));
  if (webhook) return webhook;
  const upgraded = await upgradedLegacyCredential(db, 'webhook', hash);
  if (!upgraded) return undefined;
  const [row] = await db.select({ id: webhooks.id, workspaceId: webhooks.workspaceId, tokenHash: webhooks.tokenHash })
    .from(webhooks).where(and(eq(webhooks.id, upgraded.principalId), eq(webhooks.isActive, true)));
  return row;
}
