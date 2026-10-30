import { randomHex } from '../lib/crypto.js';

/**
 * The credential families a deployment can issue.
 *
 * - `live`: `rk_live_` / `at_live_` / `nt_live_` / `ot_live_` / `wh_live_` plus
 *   a random hex secret. The default.
 * - `self_routing`: `relaycast_<kind>_<workspace_id>_<secret>` with a 64-hex
 *   secret. The workspace id is readable from the credential itself, so a
 *   stateless gateway can route a request to its workspace without a lookup.
 *   The workspace id is not secret; the engine still authenticates by hashing
 *   the whole credential and looking it up in the table for its kind.
 *
 * A deployment issues and accepts exactly one family.
 */
export type CredentialFormat = 'live' | 'self_routing';

export type CredentialKind = 'workspace' | 'agent' | 'node' | 'observer' | 'webhook';

interface LiveFamily {
  prefix: string;
  secretBytes: number;
}

const LIVE: Record<CredentialKind, LiveFamily> = {
  workspace: { prefix: 'rk_live_', secretBytes: 16 },
  agent: { prefix: 'at_live_', secretBytes: 16 },
  node: { prefix: 'nt_live_', secretBytes: 24 },
  observer: { prefix: 'ot_live_', secretBytes: 24 },
  webhook: { prefix: 'wh_live_', secretBytes: 24 },
};

const SELF_ROUTING_CODES = {
  workspace: 'ws',
  agent: 'ag',
  node: 'nd',
  observer: 'ob',
  webhook: 'wh',
} as const satisfies Record<CredentialKind, string>;

export type SelfRoutingKindCode = (typeof SELF_ROUTING_CODES)[CredentialKind];

const KIND_BY_CODE = Object.fromEntries(
  Object.entries(SELF_ROUTING_CODES).map(([kind, code]) => [code, kind]),
) as Record<SelfRoutingKindCode, CredentialKind>;

const SELF_ROUTING_SECRET_HEX = 64;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9]+$/;
const SELF_ROUTING_PATTERN = /^relaycast_(ws|ag|nd|ob|wh)_([A-Za-z0-9]+)_([0-9a-f]{64})$/;

export interface ParsedCredential {
  kind: CredentialKind;
  /** Present for `self_routing` credentials. */
  workspaceId?: string;
}

/**
 * Parse a self-routing credential without consulting any deployment state.
 * Gateways use this to route; it proves nothing about validity.
 */
export function parseSelfRoutingCredential(
  token: string,
): { kind: CredentialKind; workspaceId: string } | undefined {
  const match = SELF_ROUTING_PATTERN.exec(token);
  if (!match) return undefined;
  return { kind: KIND_BY_CODE[match[1] as SelfRoutingKindCode], workspaceId: match[2] };
}

/** Classify a presented credential under `format`. Other families do not parse. */
export function parseCredential(token: string, format: CredentialFormat): ParsedCredential | undefined {
  if (format === 'self_routing') return parseSelfRoutingCredential(token);
  for (const [kind, family] of Object.entries(LIVE) as [CredentialKind, LiveFamily][]) {
    if (token.startsWith(family.prefix)) return { kind };
  }
  return undefined;
}

/** Human-readable shape of a credential kind, for error messages. */
export function credentialShape(kind: CredentialKind, format: CredentialFormat): string {
  return format === 'self_routing'
    ? `relaycast_${SELF_ROUTING_CODES[kind]}_...`
    : `${LIVE[kind].prefix}...`;
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
    return `relaycast_${SELF_ROUTING_CODES[kind]}_${workspaceId}_${hex.slice(0, SELF_ROUTING_SECRET_HEX)}`;
  }
  const family = LIVE[kind];
  if (hex.length < family.secretBytes * 2) throw new Error('Credential secret material is too short');
  return `${family.prefix}${hex.slice(0, family.secretBytes * 2)}`;
}

/** Mint a fresh random credential of `kind` for `workspaceId`. */
export function mintCredential(format: CredentialFormat, kind: CredentialKind, workspaceId: string): string {
  const bytes = format === 'self_routing' ? SELF_ROUTING_SECRET_HEX / 2 : LIVE[kind].secretBytes;
  return credentialFromHex(format, kind, workspaceId, randomHex(bytes));
}

const formats = new WeakMap<object, CredentialFormat>();

/**
 * Bind the deployment's credential family to a database handle. Every engine
 * path that mints or classifies a credential holds the handle, so the family
 * travels with it (the same binding pattern as node liveness).
 */
export function configureCredentialFormat(db: object, format: CredentialFormat): void {
  if (format === 'live') formats.delete(db);
  else formats.set(db, format);
}

/** The credential family bound to `db`; `live` unless configured otherwise. */
export function credentialFormat(db: object): CredentialFormat {
  return formats.get(db) ?? 'live';
}

/** Mint a fresh credential in the family bound to `db`. */
export function issueCredential(db: object, kind: CredentialKind, workspaceId: string): string {
  return mintCredential(credentialFormat(db), kind, workspaceId);
}
