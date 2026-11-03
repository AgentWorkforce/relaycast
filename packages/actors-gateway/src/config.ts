/**
 * Gateway configuration from the environment. Validation is strict and
 * fails fast: a bad setting throws a {@link ConfigError}, which the CLI
 * reports as one line and exit code 64 (the container entrypoint's
 * convention). Secret values never appear in messages.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseCredentialKeyring, type CredentialKeyring } from '@relaycast/engine/gateway';

/** Exit code for a configuration refusal (matches docker/entrypoint-core.mjs). */
export const CONFIG_EXIT_CODE = 64;
/** Minimum RELAYCAST_INTERNAL_SECRET length (matches the engine). */
export const MIN_INTERNAL_SECRET_LENGTH = 32;

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(`relaycast actors gateway refused to start: ${message}`);
    this.name = 'ConfigError';
  }
}

export type FileStoreKind = 'local' | 'gcs' | 's3';

export interface GatewayConfig {
  port: number;
  /** Control plane origin (`http://127.0.0.1:7100` for `durable-actors dev`). */
  controlPlaneUrl: string;
  projectId: string;
  /** Application credential for the control plane; a local runtime needs none. */
  controlPlaneSecret: string | undefined;
  homeRegion: string | undefined;
  /** HMAC secret shared with the actors, which sign `/_relayfiles` URLs. */
  fileSigningSecret: string;
  /** Signs new workspaces' routing tags and verifies every credential's tag. */
  credentialKeyring: CredentialKeyring;
  /** Enables `/internal/*`; the actors are configured with the same value. */
  internalSecret: string | undefined;
  publicWorkspaceCreate: boolean;
  fileStore: FileStoreKind;
  fileDir: string;
  maxUploadBytes: number;
  shutdownGraceMs: number;
  logFormat: 'json' | 'text';
  environment: string;
}

/**
 * `NAME`, or the contents of the file named by `NAME_FILE`; empty →
 * undefined. A directly set (non-empty) variable wins over its `_FILE`
 * variant. An unreadable `_FILE` is a configuration refusal, never a silent
 * fallback. Mirrors `secretFromEnv` in docker/entrypoint-core.mjs.
 */
export function secretFromEnv(env: Env, name: string, readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  let value: string;
  try {
    value = readFile(file);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'read error';
    throw new ConfigError('unreadable_secret_file', `${name}_FILE points at an unreadable file (${code}).`);
  }
  const cleaned = value.trim();
  return cleaned ? cleaned : undefined;
}

const COMPONENT = /^[A-Za-z0-9._-]{1,64}$/;
const component = (what: string) =>
  z.string().regex(COMPONENT, `${what} may contain only ASCII letters, digits, '.', '-' and '_' (at most 64)`)
    .refine((value) => value !== '.' && value !== '..', `${what} must not be a path segment`);

/** An HTTP(S) origin with no credentials, path, query or fragment; normalized to `URL.origin`. */
const origin = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute http(s) URL' });
    return z.NEVER;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    ctx.addIssue({ code: 'custom', message: 'must be an http(s) origin without credentials, path, query or fragment' });
    return z.NEVER;
  }
  return url.origin;
});

const integer = (min: number) => z.string().regex(/^[0-9]+$/, 'must be a non-negative integer').transform(Number).pipe(z.number().int().min(min).max(Number.MAX_SAFE_INTEGER));

const EnvSchema = z.object({
  PORT: integer(0).pipe(z.number().max(65535)).default(8787),
  DURABLE_ACTORS_CONTROL_PLANE_URL: origin,
  DURABLE_ACTORS_PROJECT_ID: component('DURABLE_ACTORS_PROJECT_ID'),
  DURABLE_ACTORS_HOME_REGION: component('DURABLE_ACTORS_HOME_REGION').optional(),
  RELAYCAST_PUBLIC_WORKSPACE_CREATE: z.enum(['true', 'false']).default('true'),
  RELAYCAST_FILE_STORE: z.enum(['local', 'gcs', 's3']).default('local'),
  RELAYCAST_FILE_DIR: z.string().min(1).default('/data/files'),
  RELAYCAST_MAX_UPLOAD_BYTES: integer(1).default(64 * 1024 * 1024),
  RELAYCAST_SHUTDOWN_GRACE_MS: integer(0).default(10_000),
  RELAYCAST_LOG_FORMAT: z.enum(['json', 'text']).default('json'),
  RELAYCAST_ENV: z.string().min(1).default('production'),
});

/** Trimmed, with empty values dropped, so a blank variable means "unset". */
function present(env: Env, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.map(String).join('.') || 'configuration';
  const message = issue?.message ?? 'is invalid';
  return `${path} ${message}`;
}

/**
 * `schema` parsed from the present variables of `env`; a failure is a
 * {@link ConfigError} naming the first bad variable. Shared with the file
 * store factory, which validates its own `RELAYCAST_GCS_*` / `RELAYCAST_S3_*`.
 */
export function parseEnv<T extends z.ZodObject>(schema: T, env: Env): z.output<T> {
  const parsed = schema.safeParse(present(env, Object.keys(schema.shape)));
  if (!parsed.success) throw new ConfigError('invalid_config', `${firstIssue(parsed.error)}.`);
  return parsed.data;
}

/**
 * Validated configuration from `env`. Throws {@link ConfigError} for a
 * missing or malformed setting, an unreadable `_FILE`, a short internal
 * secret, an invalid keyring, or a file store this build does not implement
 * yet is not refused here (the store factory throws at startup).
 */
export function loadConfig(env: Env = process.env, readFile?: (path: string) => string): GatewayConfig {
  const settings = parseEnv(EnvSchema, env);

  const fileSigningSecret = secretFromEnv(env, 'RELAYCAST_FILE_SIGNING_SECRET', readFile);
  if (!fileSigningSecret) throw new ConfigError('missing_file_signing_secret', 'RELAYCAST_FILE_SIGNING_SECRET (or _FILE) is required.');

  const keyringJson = secretFromEnv(env, 'RELAYCAST_CREDENTIAL_KEYRING', readFile);
  if (!keyringJson) throw new ConfigError('missing_credential_keyring', 'RELAYCAST_CREDENTIAL_KEYRING (or _FILE) is required.');
  let credentialKeyring: CredentialKeyring;
  try {
    credentialKeyring = parseCredentialKeyring(keyringJson);
  } catch (error) {
    throw new ConfigError('invalid_credential_keyring', `RELAYCAST_CREDENTIAL_KEYRING: ${(error as Error).message}.`);
  }

  const internalSecret = secretFromEnv(env, 'RELAYCAST_INTERNAL_SECRET', readFile);
  if (internalSecret !== undefined && internalSecret.length < MIN_INTERNAL_SECRET_LENGTH) {
    throw new ConfigError('weak_internal_secret', `RELAYCAST_INTERNAL_SECRET must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters (openssl rand -hex 32).`);
  }

  // DURABLE_ACTORS_API_KEY is the SDK's alias for DURABLE_ACTORS_SECRET.
  const controlPlaneSecret = secretFromEnv(env, 'DURABLE_ACTORS_SECRET', readFile) ?? secretFromEnv(env, 'DURABLE_ACTORS_API_KEY', readFile);

  return {
    port: settings.PORT,
    controlPlaneUrl: settings.DURABLE_ACTORS_CONTROL_PLANE_URL,
    projectId: settings.DURABLE_ACTORS_PROJECT_ID,
    controlPlaneSecret,
    homeRegion: settings.DURABLE_ACTORS_HOME_REGION,
    fileSigningSecret,
    credentialKeyring,
    internalSecret,
    publicWorkspaceCreate: settings.RELAYCAST_PUBLIC_WORKSPACE_CREATE === 'true',
    fileStore: settings.RELAYCAST_FILE_STORE,
    fileDir: settings.RELAYCAST_FILE_DIR,
    maxUploadBytes: settings.RELAYCAST_MAX_UPLOAD_BYTES,
    shutdownGraceMs: settings.RELAYCAST_SHUTDOWN_GRACE_MS,
    logFormat: settings.RELAYCAST_LOG_FORMAT,
    environment: settings.RELAYCAST_ENV,
  };
}
