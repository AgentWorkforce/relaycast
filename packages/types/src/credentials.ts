/**
 * Relaycast credentials come in two families, and every deployment accepts both:
 *
 * - `rk_live_…` (workspace key), `at_live_…` (agent), `nt_live_…` (node),
 *   `ot_live_…` (observer), `wh_live_…` (inbound webhook);
 * - `relaycast_<ws|ag|nd|ob|wh>_<workspace_id>_<64 hex>`, which also names the
 *   workspace it belongs to.
 *
 * These helpers classify a credential by shape only; the server decides
 * whether it is valid.
 */
export type CredentialKind = 'workspace' | 'agent' | 'node' | 'observer' | 'webhook';

const LIVE_PREFIXES: readonly (readonly [string, CredentialKind])[] = [
  ['rk_live_', 'workspace'],
  ['at_live_', 'agent'],
  ['nt_live_', 'node'],
  ['ot_live_', 'observer'],
  ['wh_live_', 'webhook'],
];

const SELF_ROUTING_KINDS: Readonly<Record<string, CredentialKind>> = {
  ws: 'workspace',
  ag: 'agent',
  nd: 'node',
  ob: 'observer',
  wh: 'webhook',
};

const SELF_ROUTING = /^relaycast_(ws|ag|nd|ob|wh)_([A-Za-z0-9]+)_([0-9a-f]{64})$/;

/** The kind a credential's shape declares, for either family. */
export function credentialKind(token: string): CredentialKind | undefined {
  const routed = SELF_ROUTING.exec(token);
  if (routed) return SELF_ROUTING_KINDS[routed[1]];
  return LIVE_PREFIXES.find(([prefix]) => token.startsWith(prefix))?.[1];
}

/** The workspace a `relaycast_…` credential names; `undefined` for the `*_live_` family. */
export function credentialWorkspaceId(token: string): string | undefined {
  return SELF_ROUTING.exec(token)?.[2];
}

export function isWorkspaceKey(token: string): boolean {
  return credentialKind(token) === 'workspace';
}

export function isObserverToken(token: string): boolean {
  return credentialKind(token) === 'observer';
}

/** Either family's credentials inside free text, for redaction. Global: use with `String.replace`. */
export function credentialTextPattern(): RegExp {
  return /\b(?:(?:rk|at|nt|ot|wh)_live_[A-Za-z0-9_-]+|relaycast_(?:ws|ag|nd|ob|wh)_[A-Za-z0-9]+_[0-9a-f]{64})\b/g;
}
