import type { workspaces, agents } from './db/schema.js';
import type { Logger } from './lib/logger.js';
import type {
  EngineDb,
  EnginePorts,
  EngineProviders,
  EngineConfig,
} from './ports/index.js';

/**
 * The runtime dependency bundle injected into every request. An adapter
 * constructs this once (Node in-process for self-host; Cloudflare DO for the
 * hosted product) and `createEngine` stashes it on the Hono context so engine
 * code reads infrastructure off `c.get('engine')` instead of `c.env.*` bindings.
 */
export interface EngineRuntime extends EnginePorts, EngineProviders {
  config: EngineConfig;
}

/** Hono context variables set by middleware. */
export interface AppVariables {
  workspace: typeof workspaces.$inferSelect;
  agent: typeof agents.$inferSelect | undefined;
  db: EngineDb;
  logger: Logger;
  requestId: string;
  /**
   * Harness identifier derived from the `X-Relaycast-Harness` request header.
   * Always set (defaults to `'unknown'`). Stamped on every server-side telemetry
   * event for the request via `emitServerEvent`.
   */
  harness: string;
  /** The injected ports + providers + config for this deployment. */
  engine: EngineRuntime;
}

/**
 * The Hono Env used throughout the app. `Bindings` is empty — the engine is
 * platform-agnostic and takes no Cloudflare bindings; everything platform
 * specific arrives through {@link EngineRuntime} on `Variables.engine`.
 */
export type AppEnv = {
  Bindings: Record<string, never>;
  Variables: AppVariables;
};
