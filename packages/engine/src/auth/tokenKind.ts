import { z } from 'zod';
import type { AuthRequire } from '../ports/auth.js';

const tokenKindConfig = {
  workspace: {
    prefix: 'rk_live_',
    requiredMessage: 'Workspace key required (rk_live_...)',
  },
  agent: {
    prefix: 'at_live_',
    requiredMessage: 'Agent token required (at_live_...)',
  },
  node: {
    prefix: 'nt_live_',
    requiredMessage: 'Node token required (nt_live_...)',
  },
  observer: {
    prefix: 'ot_live_',
    requiredMessage: 'Observer token required (ot_live_...)',
  },
} as const;

export type AuthTokenKind = keyof typeof tokenKindConfig;

type ParsedTokenFor<Kind extends AuthTokenKind> = {
  kind: Kind;
  token: string;
};

const workspaceTokenSchema = z
  .string()
  .startsWith(tokenKindConfig.workspace.prefix)
  .transform((token): ParsedTokenFor<'workspace'> => ({ kind: 'workspace', token }));

const agentTokenSchema = z
  .string()
  .startsWith(tokenKindConfig.agent.prefix)
  .transform((token): ParsedTokenFor<'agent'> => ({ kind: 'agent', token }));

const nodeTokenSchema = z
  .string()
  .startsWith(tokenKindConfig.node.prefix)
  .transform((token): ParsedTokenFor<'node'> => ({ kind: 'node', token }));

const observerTokenSchema = z
  .string()
  .startsWith(tokenKindConfig.observer.prefix)
  .transform((token): ParsedTokenFor<'observer'> => ({ kind: 'observer', token }));

export const authTokenSchema = z.union([
  workspaceTokenSchema,
  agentTokenSchema,
  nodeTokenSchema,
  observerTokenSchema,
]);

export type ParsedAuthToken = z.infer<typeof authTokenSchema>;

export function parseAuthToken(token: string): ParsedAuthToken | undefined {
  const parsed = authTokenSchema.safeParse(token);
  return parsed.success ? parsed.data : undefined;
}

export function getAuthTokenKind(token: string): AuthTokenKind | undefined {
  return parseAuthToken(token)?.kind;
}

export function requiredTokenMessage(kind: Exclude<AuthRequire, 'any'>): string {
  return tokenKindConfig[kind].requiredMessage;
}

const allowedKindsByRequire = {
  workspace: ['workspace'],
  agent: ['agent'],
  node: ['node'],
  observer: ['observer'],
  // `any` intentionally means user/workspace API credentials, not transport-only
  // node credentials or scoped observer credentials.
  any: ['workspace', 'agent'],
} as const satisfies Record<AuthRequire, readonly AuthTokenKind[]>;

export type AuthRequirementValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateTokenRequirement(
  tokenKind: AuthTokenKind,
  require: AuthRequire,
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

  if (require === 'any') {
    return { ok: false, code: 'unauthorized', message: 'Invalid token format' };
  }

  return {
    ok: false,
    code: 'unauthorized',
    message: requiredTokenMessage(require),
  };
}
