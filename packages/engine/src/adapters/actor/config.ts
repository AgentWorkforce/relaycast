/**
 * Engine config for a workspace actor from its environment, with the same
 * variable names and semantics as the self-host server (`bin/serve.ts`).
 */
import { z } from 'zod';
import { ConfigError } from '../../bin/secretEnv.js';
import { MIN_INTERNAL_SECRET_LENGTH } from '../../engine/internalAdmin.js';
import type { ActorRuntimeOptions } from './index.js';

/** The engine config a workspace actor passes to `createActorRuntime`. */
export type ActorEngineConfig = NonNullable<ActorRuntimeOptions['config']>;

export const DEFAULT_ACTOR_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** An unset or blank variable is absent. */
const unsetIfBlank = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const numeric = z.preprocess(unsetIfBlank, z.coerce.number().finite().optional());
const positiveInt = z.preprocess(unsetIfBlank, z.coerce.number().int().positive().optional());
const positiveNumber = z.preprocess(unsetIfBlank, z.coerce.number().positive().optional());

const ActorEnvSchema = z.object({
  /** Largest upload the engine signs a URL for. Default 64 MiB. */
  RELAYCAST_MAX_UPLOAD_BYTES: positiveInt,
  /** Positive: prune messages after that many days. Unset, 0 or negative: keep forever. */
  RELAYCAST_MESSAGE_TTL_DAYS: numeric,
  RELAYCAST_MAILBOX_TTL_MS: positiveNumber,
  RELAYCAST_MAILBOX_DEPTH_CAP: positiveInt,
  RELAYCAST_RATE_LIMIT_PER_MINUTE: positiveInt,
  /** Enables `/internal/*`; at least 32 characters once trimmed, blank is unset (as `bin/serve.ts` reads it). */
  RELAYCAST_INTERNAL_SECRET: z.preprocess(
    unsetIfBlank,
    z.string().trim().min(MIN_INTERNAL_SECRET_LENGTH, `must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters`).optional(),
  ),
  RELAYCAST_ENV: z.preprocess(unsetIfBlank, z.string().trim().min(1).optional()),
});

/**
 * Read the actor's engine config from `env`. Throws a {@link ConfigError}
 * naming every invalid variable, so a misconfigured actor fails at
 * construction rather than serving with defaults.
 */
export function actorConfigFromEnv(env: Record<string, string | undefined>): ActorEngineConfig {
  const parsed = ActorEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid relaycast actor configuration: ${problems.join('; ')}`);
  }
  const values = parsed.data;
  const mailbox = {
    ...(values.RELAYCAST_MAILBOX_TTL_MS !== undefined ? { deliveryTtlMs: values.RELAYCAST_MAILBOX_TTL_MS } : {}),
    ...(values.RELAYCAST_MAILBOX_DEPTH_CAP !== undefined ? { depthCap: values.RELAYCAST_MAILBOX_DEPTH_CAP } : {}),
  };
  const ttlDays = values.RELAYCAST_MESSAGE_TTL_DAYS;
  return {
    environment: values.RELAYCAST_ENV ?? 'production',
    maxUploadBytes: values.RELAYCAST_MAX_UPLOAD_BYTES ?? DEFAULT_ACTOR_MAX_UPLOAD_BYTES,
    retention: { messageTtlDays: ttlDays !== undefined && ttlDays > 0 ? ttlDays : null },
    ...(values.RELAYCAST_INTERNAL_SECRET !== undefined ? { internalSecret: values.RELAYCAST_INTERNAL_SECRET } : {}),
    ...(values.RELAYCAST_RATE_LIMIT_PER_MINUTE !== undefined ? { rateLimitPerMinute: values.RELAYCAST_RATE_LIMIT_PER_MINUTE } : {}),
    ...(Object.keys(mailbox).length > 0 ? { mailbox } : {}),
  };
}
