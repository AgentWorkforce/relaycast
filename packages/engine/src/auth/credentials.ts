import {
  LIVE_CREDENTIAL_PREFIXES,
  SELF_ROUTING_KIND_CODES,
  parseCredential,
  type CredentialFamily,
  type CredentialKind,
  type ParsedCredential,
} from '@relaycast/types';
import { randomHex } from '../lib/crypto.js';

/**
 * The two credential families.
 *
 * - `live`: `rk_live_` / `at_live_` / `nt_live_` / `ot_live_` / `wh_live_` plus
 *   a random hex secret.
 * - `self_routing`: `relaycast_<kind>_<workspace_id>_<secret>` with a 64-hex
 *   secret. The workspace id is readable from the credential itself, so a
 *   stateless gateway can route a request to its workspace without a lookup.
 *   The workspace id is not secret; the engine still authenticates by hashing
 *   the whole credential and looking it up in the table for its kind, within
 *   that workspace.
 *
 * Every deployment accepts both families. Which one it mints is per deployment
 * (`EngineConfig.credentialFormat`, default `live`).
 */
export type CredentialFormat = CredentialFamily;
export type { CredentialKind, ParsedCredential };
export { parseCredential };

/** Random secret bytes per `live` kind (the established lengths). */
const LIVE_SECRET_BYTES: Record<CredentialKind, number> = {
  workspace: 16,
  agent: 16,
  node: 24,
  observer: 24,
  webhook: 24,
};

const SELF_ROUTING_SECRET_HEX = 64;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * Parse a self-routing credential, for gateways that route by it. Proves
 * nothing about validity.
 */
export function parseSelfRoutingCredential(
  token: string,
): { kind: CredentialKind; workspaceId: string } | undefined {
  const parsed = parseCredential(token);
  return parsed?.family === 'self_routing' ? { kind: parsed.kind, workspaceId: parsed.workspaceId } : undefined;
}

/** Human-readable shape of a credential kind in the family a deployment mints, for error messages. */
export function credentialShape(kind: CredentialKind, format: CredentialFormat): string {
  return format === 'self_routing'
    ? `relaycast_${SELF_ROUTING_KIND_CODES[kind]}_...`
    : `${LIVE_CREDENTIAL_PREFIXES[kind]}...`;
}

/** Whether `workspaceId` can be embedded in a self-routing credential. */
export function selfRoutingWorkspaceIdOk(workspaceId: string): boolean {
  return WORKSPACE_ID_PATTERN.test(workspaceId);
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`Workspace id ${JSON.stringify(workspaceId)} cannot be embedded in a self-routing credential`);
  }
}

/**
 * Build a credential from caller-supplied hex secret material (a random value
 * or a deterministic HMAC/SHA-256 digest). The material is truncated to the
 * family's secret length, so it must be at least that long.
 */
export function credentialFromHex(
  format: CredentialFormat,
  kind: CredentialKind,
  workspaceId: string,
  hex: string,
): string {
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('Credential secret material must be lowercase hex');
  if (format === 'self_routing') {
    assertWorkspaceId(workspaceId);
    if (hex.length < SELF_ROUTING_SECRET_HEX) throw new Error('Credential secret material is too short');
    return `relaycast_${SELF_ROUTING_KIND_CODES[kind]}_${workspaceId}_${hex.slice(0, SELF_ROUTING_SECRET_HEX)}`;
  }
  const length = LIVE_SECRET_BYTES[kind] * 2;
  if (hex.length < length) throw new Error('Credential secret material is too short');
  return `${LIVE_CREDENTIAL_PREFIXES[kind]}${hex.slice(0, length)}`;
}

/** Mint a fresh random credential of `kind` for `workspaceId`. */
export function mintCredential(format: CredentialFormat, kind: CredentialKind, workspaceId: string): string {
  const bytes = format === 'self_routing' ? SELF_ROUTING_SECRET_HEX / 2 : LIVE_SECRET_BYTES[kind];
  return credentialFromHex(format, kind, workspaceId, randomHex(bytes));
}

const formats = new WeakMap<object, CredentialFormat>();

/**
 * Bind the family a deployment mints to its database handle. Every engine path
 * that mints a credential holds the handle, so the family travels with it (the
 * same binding pattern as node liveness).
 */
export function configureCredentialFormat(db: object, format: CredentialFormat): void {
  const bound = formats.get(db);
  if (bound !== undefined && bound !== format) {
    throw new Error(`This database handle already mints ${bound} credentials; one handle serves one credential format`);
  }
  formats.set(db, format);
}

/** The credential family `db`'s deployment mints; `live` unless configured otherwise. */
export function credentialFormat(db: object): CredentialFormat {
  return formats.get(db) ?? 'live';
}

/** Mint a fresh credential in the family bound to `db`. */
export function issueCredential(db: object, kind: CredentialKind, workspaceId: string): string {
  return mintCredential(credentialFormat(db), kind, workspaceId);
}
