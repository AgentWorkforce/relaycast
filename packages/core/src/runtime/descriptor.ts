import type { RuntimeCapabilities, WorkflowRuntime } from './types.js';

export interface RuntimeDescriptor {
  id: string;
  displayName: string;
  status: 'stable' | 'beta' | 'alpha' | 'experimental';
  capabilities: RuntimeCapabilities;
  description: string;
  configSchema?: RuntimeConfigSchema;
  docsUrl?: string;
}

export interface RuntimeConfigSchema {
  required: string[];
  optional: string[];
  envVars: string[];
}

/**
 * Config is intentionally unknown here: the registry is runtime-polymorphic,
 * and each runtime factory owns validation at its boundary.
 */
export type RuntimeFactory = (config: unknown) => WorkflowRuntime | Promise<WorkflowRuntime>;

export interface RuntimeRegistration {
  descriptor: RuntimeDescriptor;
  factory: RuntimeFactory;
}
