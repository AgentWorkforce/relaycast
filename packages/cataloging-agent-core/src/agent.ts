import type { Hono } from "hono";

import { buildCatalogingWorker } from "./worker.js";
import {
  registerCatalogingAgentConfig,
  type CatalogingAgentConfig,
  type CatalogingWorkerEnv,
} from "./config.js";

export type { CatalogingAgentConfig, CatalogingWorkerEnv } from "./config.js";

export function createCatalogingAgent<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
): Hono<{ Bindings: TEnv }> {
  registerCatalogingAgentConfig(config);
  return buildCatalogingWorker(config);
}
