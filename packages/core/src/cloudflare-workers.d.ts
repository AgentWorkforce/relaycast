// Minimal type shim for cloudflare:workers used by nango-sync-workflow.ts.
// The full type package (@cloudflare/workers-types) is wired into
// packages/webhook-worker which actually deploys CF Worker code; here we only
// need the Workflow-related types so @cloud/core can compile.
declare module "cloudflare:workers" {
  export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly ctx: ExecutionContext;
    protected readonly env: Env;
    // biome-ignore lint: required override
    run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }

  export type WorkflowEvent<Params = unknown> = {
    payload: Params;
    timestamp: Date;
    instanceId: string;
  };

  export type WorkflowStepConfig = {
    retries?: {
      limit?: number;
      delay?: string | number;
      backoff?: "constant" | "linear" | "exponential";
    };
    timeout?: string | number;
  };

  export type WorkflowStep = {
    do<T>(
      name: string,
      callback: () => Promise<T>,
    ): Promise<T>;
    do<T>(
      name: string,
      config: WorkflowStepConfig,
      callback: () => Promise<T>,
    ): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
  };

  export type WorkflowBinding = {
    create(opts?: {
      id?: string;
      params?: unknown;
    }): Promise<{ id: string }>;
    get(id: string): Promise<unknown>;
  };

  // Stub for other CF types referenced transitively — kept minimal.
  export type ExecutionContext = {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  };
}
