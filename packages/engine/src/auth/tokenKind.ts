import type { AuthRequire } from '../ports/auth.js';
import { credentialShape, parseCredential, type CredentialFormat } from './credentials.js';

const tokenKindLabel = {
  workspace: 'Workspace key',
  agent: 'Agent token',
  node: 'Node token',
  observer: 'Observer token',
} as const;

export type AuthTokenKind = keyof typeof tokenKindLabel;

export interface ParsedAuthToken {
  kind: AuthTokenKind;
  token: string;
  /** The credential's family. */
  family: 'legacy' | 'ar';
  /** The workspace an `ar_` credential names. */
  workspaceId?: string;
}

/** Classify an API credential of either family. */
export function parseAuthToken(token: string): ParsedAuthToken | undefined {
  const parsed = parseCredential(token);
  if (!parsed || parsed.kind === 'webhook') return undefined;
  return parsed.family === 'ar'
    ? { kind: parsed.kind, token, family: 'ar', workspaceId: parsed.workspaceId }
    : { kind: parsed.kind, token, family: 'legacy' };
}

export function getAuthTokenKind(token: string): AuthTokenKind | undefined {
  return parseAuthToken(token)?.kind;
}

export function requiredTokenMessage(
  kind: Exclude<AuthRequire, 'any' | 'sender'>,
  format: CredentialFormat,
): string {
  return `${tokenKindLabel[kind]} required (${credentialShape(kind, format)})`;
}

const allowedKindsByRequire = {
  workspace: ['workspace'],
  agent: ['agent'],
  node: ['node'],
  observer: ['observer'],
  // `any` intentionally means user/workspace API credentials, not transport-only
  // node credentials or scoped observer credentials.
  any: ['workspace', 'agent'],
  // `sender` is a principal that can post a message: a workspace key, an agent
  // (posts as itself), or a node token (posts as an explicit `from` agent).
  sender: ['workspace', 'agent', 'node'],
} as const satisfies Record<AuthRequire, readonly AuthTokenKind[]>;

export type AuthRequirementValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateTokenRequirement(
  tokenKind: AuthTokenKind,
  require: AuthRequire,
  format: CredentialFormat,
): AuthRequirementValidation {
  const allowedKinds: readonly AuthTokenKind[] = allowedKindsByRequire[require];
  if (allowedKinds.includes(tokenKind)) {
    return { ok: true };
  }

  if (tokenKind === 'node') {
    return {
      ok: false,
      code: 'node_token_forbidden',
      message: 'Node token cannot perform this operation',
    };
  }

  if (tokenKind === 'observer') {
    return {
      ok: false,
      code: 'observer_token_forbidden',
      message: 'Observer token cannot perform this operation',
    };
  }

  if (require === 'any' || require === 'sender') {
    return { ok: false, code: 'unauthorized', message: 'Invalid token format' };
  }

  return {
    ok: false,
    code: 'unauthorized',
    message: requiredTokenMessage(require, format),
  };
}
