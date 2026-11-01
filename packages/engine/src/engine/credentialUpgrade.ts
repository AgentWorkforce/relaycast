import { and, eq, gt, notExists, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { isArWorkspaceId, type CredentialKind } from '@relaycast/types';
import { agents, credentialUpgrades, nodes, observerTokens, webhooks, workspaces } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';
import { runAtomicWrites } from '../ports/database.js';
import { credentialTagger, mintCredential } from '../auth/credentials.js';
import { sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';

/** How long an upgraded legacy credential keeps working, unless configured: 30 days. */
export const DEFAULT_LEGACY_CREDENTIAL_GRACE_SECONDS = 30 * 24 * 60 * 60;

/** The longest grace period a deployment may configure: 10 years. */
export const MAX_LEGACY_CREDENTIAL_GRACE_SECONDS = 10 * 365 * 24 * 60 * 60;

/** The column each kind of principal keeps its credential hash in. */
const PRINCIPALS = {
  workspace: { table: workspaces, id: workspaces.id, hash: workspaces.apiKeyHash },
  agent: { table: agents, id: agents.id, hash: agents.tokenHash },
  node: { table: nodes, id: nodes.id, hash: nodes.tokenHash },
  observer: { table: observerTokens, id: observerTokens.id, hash: observerTokens.tokenHash },
  webhook: { table: webhooks, id: webhooks.id, hash: webhooks.tokenHash },
} as const;

/**
 * The grace record, inserted only when the principal now holds `arHash` (the
 * swap earlier in the same group matched) and no record for the legacy hash
 * exists yet.
 */
function graceRecordAfterSwap(
  w: EngineDb,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  hashColumn: SQLiteColumn,
  row: {
    legacyHash: string;
    kind: CredentialKind;
    principalId: string;
    workspaceId: string;
    arHash: string;
    sealedCredential: string;
    expiresAt: Date;
  },
) {
  return w.insert(credentialUpgrades).select(
    w.select({
      legacyHash: sql<string>`${row.legacyHash}`.as('legacy_hash'),
      kind: sql<string>`${row.kind}`.as('kind'),
      principalId: sql<string>`${row.principalId}`.as('principal_id'),
      workspaceId: sql<string>`${row.workspaceId}`.as('workspace_id'),
      arHash: sql<string>`${row.arHash}`.as('ar_hash'),
      sealedCredential: sql<string>`${row.sealedCredential}`.as('sealed_credential'),
      createdAt: sql<Date>`unixepoch()`.as('created_at'),
      expiresAt: sql<Date>`${Math.floor(row.expiresAt.getTime() / 1000)}`.as('expires_at'),
    })
      .from(table)
      .where(and(
        eq(idColumn, row.principalId),
        eq(hashColumn, row.arHash),
        notExists(w.select({ one: sql`1` }).from(credentialUpgrades).where(eq(credentialUpgrades.legacyHash, row.legacyHash))),
      )),
  );
}

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

const encoder = new TextEncoder();

/**
 * The AES-GCM key that seals an upgrade's `ar_` credential, derived from the
 * legacy credential (HKDF-SHA256). Only a holder of the legacy credential can
 * open the sealed copy, and the route hands it out only during the grace.
 */
async function sealingKey(legacyToken: string, legacyHash: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(legacyToken), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(legacyHash), info: encoder.encode('relaycast:credential-upgrade:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function seal(credential: string, legacyToken: string, legacyHash: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await sealingKey(legacyToken, legacyHash), encoder.encode(credential),
  ));
  return `${toBase64(iv)}.${toBase64(box)}`;
}

async function unseal(sealed: string, legacyToken: string, legacyHash: string): Promise<string> {
  const [iv, box] = sealed.split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, await sealingKey(legacyToken, legacyHash), fromBase64(box),
  );
  return new TextDecoder().decode(plain);
}

export interface CredentialUpgradeResult {
  credential: string;
  kind: CredentialKind;
  legacyExpiresAt: Date;
}

/**
 * Replace a principal's legacy credential with a fresh random `ar_` one. The
 * principal's hash column takes the `ar_` credential; the legacy one keeps
 * authenticating for `graceSeconds`. The grace record keeps the `ar_`
 * credential sealed with a key derived from the legacy credential, so
 * upgrading the same legacy credential again (or concurrently) returns the
 * same `ar_` credential, and nothing in the record or in public data rebuilds
 * it. `currentHash` is the principal's stored hash, so a credential that only
 * authenticates through a rotation grace slot (already superseded) is refused.
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
  const principal = PRINCIPALS[kind];

  /**
   * The upgrade that claimed this legacy credential, while the principal still
   * holds its `ar_` credential. The claim, not the grace, decides: a race
   * loser gets the winner's credential even with a zero grace.
   */
  const claimed = async () => {
    const [record] = await db.select().from(credentialUpgrades).where(eq(credentialUpgrades.legacyHash, legacyHash));
    if (!record) return undefined;
    const [current] = await db.select({ hash: principal.hash }).from(principal.table).where(eq(principal.id, principalId));
    if (current?.hash !== record.arHash) throw superseded();
    return record;
  };

  const existing = await claimed();
  if (existing) {
    // Once the grace ends the legacy credential no longer authenticates (the
    // route answers 401 first); its holder uses the ar_ credential, or rotates
    // it through a workspace key if it was lost.
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw codedError(
        'The legacy credential\'s grace has ended; use its ar_ credential, or rotate it if lost',
        'credential_grace_expired',
        401,
      );
    }
    return { credential: await unseal(existing.sealedCredential, legacyToken, legacyHash), kind, legacyExpiresAt: existing.expiresAt };
  }
  if (args.currentHash !== legacyHash) throw superseded();

  const credential = await mintCredential(db, 'ar', kind, workspaceId);
  const arHash = await sha256Hex(credential);
  const sealedCredential = await seal(credential, legacyToken, legacyHash);
  const now = new Date();
  const legacyExpiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + args.graceSeconds * 1000);
  // One atomic group: the grace record (the claim) exists only if the hash
  // swap matched. A rotation, or a concurrent upgrade of the same credential,
  // that lands first leaves the principal off `arHash`, so the insert selects
  // nothing and an existing claim is never overwritten.
  await runAtomicWrites(db, (w) => [
    swapPrincipalHash(w, kind, principalId, legacyHash, arHash),
    graceRecordAfterSwap(w, principal.table, principal.id, principal.hash, {
      legacyHash, kind, principalId, workspaceId, arHash, sealedCredential, expiresAt: legacyExpiresAt,
    }),
  ], { requireAtomic: true });

  const [current] = await db.select({ hash: principal.hash }).from(principal.table).where(eq(principal.id, principalId));
  if (current?.hash === arHash) return { credential, kind, legacyExpiresAt };
  // A concurrent upgrade of the same credential won: return its credential,
  // sealed under the same legacy credential. A rotation that won left no claim.
  const winner = await claimed();
  if (!winner) throw superseded();
  return { credential: await unseal(winner.sealedCredential, legacyToken, legacyHash), kind, legacyExpiresAt: winner.expiresAt };
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
