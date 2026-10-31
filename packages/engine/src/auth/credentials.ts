import {
  AR_KIND_CODES,
  AR_SECRET_BYTES,
  LEGACY_CREDENTIAL_PREFIXES,
  encodeArCredential,
  isArWorkspaceId,
  parseCredential,
  type CredentialFamily,
  type CredentialKind,
  type ParsedCredential,
} from '@relaycast/types';
import { randomHex } from '../lib/crypto.js';
import type { CredentialTagger } from './credentialTags.js';

/**
 * The two credential families (`@relaycast/types` `parseCredential`).
 *
 * - `legacy`: `rk_live_` / `at_live_` / `nt_live_` / `ot_live_` / `wh_live_`
 *   plus a random hex secret.
 * - `ar`: `ar_<kind>_<wsid>_<tag>_<secret><crc>`. The workspace is readable
 *   from the credential, so a stateless gateway routes a request to its
 *   workspace without a lookup, and the tag proves the deployment's keyring
 *   tagged that workspace. The engine still authenticates by hashing the whole
 *   credential and looking it up in the table for its kind, within that
 *   workspace.
 *
 * Every deployment accepts both families. Which one it mints is per deployment
 * (`EngineConfig.credentialFormat`, default `legacy`); minting `ar` needs a
 * {@link CredentialTagger} (`EngineConfig.credentialTagger`).
 */
export type CredentialFormat = CredentialFamily;
export type { CredentialKind, ParsedCredential };
export { parseCredential };

/** Why a deployment that mints `ar_` credentials refuses a workspace id. */
export const AR_WORKSPACE_ID_REQUIRED = 'workspace ids must be snowflakes on deployments that mint ar_ credentials';

/**
 * Minting an `ar_` credential for a workspace id that is not a 64-bit
 * snowflake. Routes check ids before writing; this is the backstop, and it
 * answers `400 invalid_request`.
 */
export class WorkspaceIdNotSnowflakeError extends Error {
  readonly code = 'invalid_request';
  readonly status = 400;
  readonly clientSafe = true;

  constructor(readonly workspaceId: string) {
    super(AR_WORKSPACE_ID_REQUIRED);
    this.name = 'WorkspaceIdNotSnowflakeError';
  }
}

/** Random secret bytes per `legacy` kind (the established lengths). */
const LEGACY_SECRET_BYTES: Record<CredentialKind, number> = {
  workspace: 16,
  agent: 16,
  node: 24,
  observer: 24,
  webhook: 24,
};

/**
 * Parse an `ar_` credential, for gateways that route by it. Proves only shape
 * and checksum; verify its tag with `createCredentialTagSigner(...).verify`.
 */
export function parseArCredential(
  token: string,
): { kind: CredentialKind; workspaceId: string; tag: string; keyVersion: string } | undefined {
  const parsed = parseCredential(token);
  return parsed?.family === 'ar'
    ? { kind: parsed.kind, workspaceId: parsed.workspaceId, tag: parsed.tag, keyVersion: parsed.keyVersion }
    : undefined;
}

/** Human-readable shape of a credential kind in the family a deployment mints, for error messages. */
export function credentialShape(kind: CredentialKind, format: CredentialFormat): string {
  return format === 'ar' ? `ar_${AR_KIND_CODES[kind]}_...` : `${LEGACY_CREDENTIAL_PREFIXES[kind]}...`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

interface CredentialSettings {
  format: CredentialFormat;
  tagger?: CredentialTagger;
}

const settings = new WeakMap<object, CredentialSettings>();

/**
 * Bind the family a deployment mints, and its tagger, to its database handle.
 * Every engine path that mints a credential holds the handle, so the settings
 * travel with it (the same binding pattern as node liveness).
 */
export function configureCredentials(db: object, next: CredentialSettings): void {
  if (next.format === 'ar' && !next.tagger) {
    throw new Error("credentialFormat 'ar' needs a credentialTagger");
  }
  const bound = settings.get(db);
  if (bound !== undefined && (bound.format !== next.format || bound.tagger !== next.tagger)) {
    throw new Error(`This database handle already mints ${bound.format} credentials; one handle serves one credential configuration`);
  }
  settings.set(db, next);
}

const arOnlyHandles = new WeakSet<object>();

/**
 * Accept only `ar_` credentials on `db`'s deployment: legacy ones are refused
 * with 401, `POST /v1/credentials/upgrade` is not served and no response is
 * marked deprecated. Inherent to the workspace actor runtime, whose
 * deployments never issued legacy credentials; call before `createEngine`.
 */
export function restrictToArCredentials(db: object): void {
  arOnlyHandles.add(db);
}

/** Whether `db`'s deployment accepts only `ar_` credentials. */
export function acceptsOnlyAr(db: object): boolean {
  return arOnlyHandles.has(db);
}

/** Carry `db`'s credential settings onto a derived handle (a transaction). */
export function inheritCredentials(derived: object, db: object): void {
  const bound = settings.get(db);
  if (bound) configureCredentials(derived, bound);
  if (arOnlyHandles.has(db)) arOnlyHandles.add(derived);
}

/** The credential family `db`'s deployment mints; `legacy` unless configured otherwise. */
export function credentialFormat(db: object): CredentialFormat {
  return settings.get(db)?.format ?? 'legacy';
}

/** The deployment's tagger, when it can mint `ar_` credentials. */
export function credentialTagger(db: object): CredentialTagger | undefined {
  return settings.get(db)?.tagger;
}

/** Whether the deployment can mint an `ar_` credential for `workspaceId`. */
export function canMintAr(db: object, workspaceId: string): boolean {
  return credentialTagger(db) !== undefined && isArWorkspaceId(workspaceId);
}

/**
 * Build a credential from caller-supplied hex secret material (a random value
 * or a deterministic HMAC/SHA-256 digest), at least as long as the family's
 * secret. An `ar_` credential carries `tag`, by default the deployment's
 * current tag for the workspace.
 */
export async function credentialFromHex(
  db: object,
  format: CredentialFormat,
  kind: CredentialKind,
  workspaceId: string,
  hex: string,
  tag?: string,
): Promise<string> {
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('Credential secret material must be lowercase hex');
  if (format === 'ar') {
    if (!isArWorkspaceId(workspaceId)) throw new WorkspaceIdNotSnowflakeError(workspaceId);
    if (hex.length < AR_SECRET_BYTES * 2) throw new Error('Credential secret material is too short');
    const tagger = credentialTagger(db);
    if (!tag && !tagger) throw new Error('Minting an ar_ credential needs EngineConfig.credentialTagger');
    return encodeArCredential({
      kind,
      workspaceId,
      tag: tag ?? await tagger!.tag(workspaceId),
      secret: hexToBytes(hex.slice(0, AR_SECRET_BYTES * 2)),
    });
  }
  const length = LEGACY_SECRET_BYTES[kind] * 2;
  if (hex.length < length) throw new Error('Credential secret material is too short');
  return `${LEGACY_CREDENTIAL_PREFIXES[kind]}${hex.slice(0, length)}`;
}

/** Mint a fresh random credential of `kind` for `workspaceId`, in `format`. */
export function mintCredential(db: object, format: CredentialFormat, kind: CredentialKind, workspaceId: string): Promise<string> {
  const bytes = format === 'ar' ? AR_SECRET_BYTES : LEGACY_SECRET_BYTES[kind];
  return credentialFromHex(db, format, kind, workspaceId, randomHex(bytes));
}

/** Mint a fresh credential in the family bound to `db`. */
export function issueCredential(db: object, kind: CredentialKind, workspaceId: string): Promise<string> {
  return mintCredential(db, credentialFormat(db), kind, workspaceId);
}
