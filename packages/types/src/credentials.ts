/**
 * Relaycast credentials come in two families, and every deployment accepts both:
 *
 * - `live`: `rk_live_…` (workspace key), `at_live_…` (agent), `nt_live_…`
 *   (node), `ot_live_…` (observer), `wh_live_…` (inbound webhook);
 * - `self_routing`: `relaycast_<ws|ag|nd|ob|wh>_<workspace_id>_<64 hex>`, which
 *   also names the workspace it belongs to.
 *
 * This module is the one classifier of credential shape for the engine and
 * every client. Shape says nothing about validity; the server decides that.
 */
export type CredentialKind = 'workspace' | 'agent' | 'node' | 'observer' | 'webhook';
export type CredentialFamily = 'live' | 'self_routing';

export type ParsedCredential =
  | { family: 'live'; kind: CredentialKind }
  | { family: 'self_routing'; kind: CredentialKind; workspaceId: string };

/** The `live` prefix for each kind. */
export const LIVE_CREDENTIAL_PREFIXES: Readonly<Record<CredentialKind, string>> = {
  workspace: 'rk_live_',
  agent: 'at_live_',
  node: 'nt_live_',
  observer: 'ot_live_',
  webhook: 'wh_live_',
};

/** The `self_routing` kind code for each kind (`relaycast_<code>_…`). */
export const SELF_ROUTING_KIND_CODES: Readonly<Record<CredentialKind, string>> = {
  workspace: 'ws',
  agent: 'ag',
  node: 'nd',
  observer: 'ob',
  webhook: 'wh',
};

const KIND_BY_CODE = Object.fromEntries(
  Object.entries(SELF_ROUTING_KIND_CODES).map(([kind, code]) => [code, kind]),
) as Record<string, CredentialKind>;

const KINDS = Object.keys(LIVE_CREDENTIAL_PREFIXES) as CredentialKind[];
const SELF_ROUTING = /^relaycast_(ws|ag|nd|ob|wh)_([A-Za-z0-9]+)_([0-9a-f]{64})$/;

/** Family, kind and (for `self_routing`) workspace of a credential, from its shape. */
export function parseCredential(token: string): ParsedCredential | undefined {
  const routed = SELF_ROUTING.exec(token);
  if (routed) return { family: 'self_routing', kind: KIND_BY_CODE[routed[1]], workspaceId: routed[2] };
  const kind = KINDS.find((candidate) => token.startsWith(LIVE_CREDENTIAL_PREFIXES[candidate]));
  return kind ? { family: 'live', kind } : undefined;
}

export function credentialKind(token: string): CredentialKind | undefined {
  return parseCredential(token)?.kind;
}

/** The workspace a `self_routing` credential names; `undefined` for the `live` family. */
export function credentialWorkspaceId(token: string): string | undefined {
  const parsed = parseCredential(token);
  return parsed?.family === 'self_routing' ? parsed.workspaceId : undefined;
}

export function isWorkspaceKey(token: string): boolean {
  return credentialKind(token) === 'workspace';
}

export function isObserverToken(token: string): boolean {
  return credentialKind(token) === 'observer';
}

/**
 * A credential with its secret hidden, safe to display: the family prefix and
 * kind (and the workspace id of a `self_routing` credential) stay, the secret
 * shows only its first and last four characters.
 */
export function maskCredential(token: string): string {
  const parsed = parseCredential(token);
  if (parsed?.family === 'self_routing') {
    const secret = token.slice(-64);
    return `relaycast_${SELF_ROUTING_KIND_CODES[parsed.kind]}_${parsed.workspaceId}_${secret.slice(0, 4)}...${secret.slice(-4)}`;
  }
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}...${token.slice(-4)}`;
}

/**
 * Credentials of either family anywhere in `text`, matched by structure (no
 * word boundaries), so one glued to surrounding text is still found.
 */
const CREDENTIAL_IN_TEXT = /relaycast_(?:ws|ag|nd|ob|wh)_[A-Za-z0-9]+_[0-9a-f]{64}|(?:rk|at|nt|ot|wh)_live_[A-Za-z0-9_-]+/g;

export function redactCredentials(text: string, replacement: string): string {
  return text.replace(CREDENTIAL_IN_TEXT, () => replacement);
}
