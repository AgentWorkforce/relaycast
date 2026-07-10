import { CLIs, type CLI } from "@agent-relay/config";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

/**
 * Spawnable harnesses are DERIVED from the agent-relay CLI registry
 * (`@agent-relay/config` `CLIs`) while remaining limited to the harnesses Cloud
 * installs and supports in the Daytona image.
 */
export const SPAWNABLE_CLIS: readonly CLI[] = Object.freeze(
  [
    CLIs.CLAUDE,
    CLIs.CODEX,
    CLIs.GEMINI,
    CLIs.CURSOR,
    CLIs.DROID,
    CLIs.OPENCODE,
    CLIs.GROK,
    CLIs.AIDER,
  ] satisfies CLI[],
);

export type SpawnableCli = (typeof SPAWNABLE_CLIS)[number];
export type FactorySpawnCliCapability = `spawn:${SpawnableCli}`;

/** Every `spawn:<cli>` capability plus the special `workflow:run`. */
export const FACTORY_SPAWN_CAPABILITIES: readonly FactorySpawnCapability[] = Object.freeze([
  ...SPAWNABLE_CLIS.map((cli): FactorySpawnCliCapability => `spawn:${cli}`),
  "workflow:run" as const,
]);

export type FactorySpawnCapability = FactorySpawnCliCapability | "workflow:run";

/** Default harness when no per-issue/recipe preference is supplied. */
export const DEFAULT_SPAWN_CLI: SpawnableCli = CLIs.CLAUDE;
export const DEFAULT_SPAWN_CAPABILITY: FactorySpawnCapability = `spawn:${DEFAULT_SPAWN_CLI}`;

const SPAWNABLE_CLI_SET = new Set<string>(SPAWNABLE_CLIS);

/** Validate an arbitrary string against the harness registry. */
export function isSpawnableCli(value: string): value is SpawnableCli {
  return SPAWNABLE_CLI_SET.has(value);
}

/** Build a typed `spawn:<cli>` capability, defaulting to claude for unknown input. */
export function spawnCapabilityForCli(cli: string | undefined | null): FactorySpawnCapability {
  return cli && isSpawnableCli(cli) ? (`spawn:${cli}` as const) : DEFAULT_SPAWN_CAPABILITY;
}

export type FactorySpawnInput = {
  name: string;
  capability: FactorySpawnCapability;
  workspaceId: string;
  invocationId: string;
  task?: string;
  model?: string;
  persona?: string;
  repo?: string;
  clonePath?: string;
  channel?: string;
  recipe?: "single" | "workflow" | "team";
  issue?: {
    id: string;
    key: string;
    title: string;
    path: string;
  };
  workflow?: string;
  inputs?: Record<string, unknown>;
};

export type FactorySpawnResult = {
  name: string;
  invocationId: string;
  sessionRef?: string;
};

export interface FactoryFleetEmitter {
  spawn(input: FactorySpawnInput): Promise<FactorySpawnResult>;
}

type RelaycastInvokeResponse = {
  data?: {
    invocation_id?: unknown;
    invocationId?: unknown;
    session_ref?: unknown;
    sessionRef?: unknown;
  };
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function capabilityToCli(capability: FactorySpawnCapability): string | null {
  if (capability === "workflow:run") return null;
  // Generic `spawn:<cli>` → `<cli>`, validated against the registry. Unknown
  // harnesses (or a malformed capability) return null rather than guessing.
  // Guard the runtime type explicitly: `capability` is typed, but this is an
  // exported boundary that can receive untyped values (e.g. persisted issue
  // metadata), so a non-string would otherwise crash on `.startsWith`.
  const cli =
    typeof capability === "string" && capability.startsWith("spawn:")
      ? capability.slice("spawn:".length)
      : "";
  return isSpawnableCli(cli) ? cli : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export class RelaycastFactoryFleetEmitter implements FactoryFleetEmitter {
  async spawn(input: FactorySpawnInput): Promise<FactorySpawnResult> {
    const relayWorkspace = await resolveOrProvisionRelayWorkspace({
      userId: input.inputs?.deployerUserId as string || "factory-cloud-worker",
      appWorkspaceId: input.workspaceId,
      name: "factory",
    });
    const action = input.capability === "workflow:run" ? "workflow:run" : "spawn";
    const response = await fetch(
      `${trimTrailingSlash(resolveRelaycastUrl())}/v1/actions/${encodeURIComponent(action)}/invoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayWorkspace.relaycastApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          invocation_id: input.invocationId,
          input: actionInput(input),
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as RelaycastInvokeResponse | null;
    const invocationId =
      readString(payload?.data?.invocation_id) ??
      readString(payload?.data?.invocationId) ??
      input.invocationId;
    if (!response.ok) {
      throw new Error(`RelayFleetClient.spawn failed: ${response.status} ${response.statusText}`);
    }

    return {
      name: input.name,
      invocationId,
      sessionRef: readString(payload?.data?.session_ref) ?? readString(payload?.data?.sessionRef),
    };
  }
}

function actionInput(input: FactorySpawnInput): Record<string, unknown> {
  if (input.capability === "workflow:run") {
    return {
      name: input.name,
      workflow: input.workflow,
      inputs: input.inputs ?? {},
      task: input.task,
      channel: input.channel,
      factory: factoryMetadata(input),
    };
  }

  return {
    name: input.name,
    cli: capabilityToCli(input.capability),
    task: input.task,
    inputs: input.inputs ?? {},
    model: input.model,
    channel: input.channel,
    persona: input.persona,
    repo: input.repo,
    clone_path: input.clonePath,
    factory: factoryMetadata(input),
  };
}

function factoryMetadata(input: FactorySpawnInput): Record<string, unknown> {
  return {
    recipe: input.recipe,
    issue: input.issue,
    workspaceId: input.workspaceId,
    invocationId: input.invocationId,
    capability: input.capability,
  };
}

type PackageRelayFleetClientCtor = new () => {
  spawn(input: FactorySpawnInput): Promise<{ name?: string; sessionRef?: string; invocationId?: string }>;
};

async function loadPackageRelayFleetClient(): Promise<PackageRelayFleetClientCtor | null> {
  try {
    const importer = Function("specifier", "return import(specifier)") as
      (specifier: string) => Promise<{ RelayFleetClient?: PackageRelayFleetClientCtor }>;
    return (await importer("@agent-relay/factory")).RelayFleetClient ?? null;
  } catch {
    return null;
  }
}

export async function createDefaultFactoryFleetEmitter(): Promise<FactoryFleetEmitter> {
  const PackageClient = await loadPackageRelayFleetClient();
  if (PackageClient) {
    const client = new PackageClient();
    return {
      async spawn(input) {
        const result = await client.spawn(input);
        return {
          name: result.name ?? input.name,
          invocationId: result.invocationId ?? input.invocationId,
          sessionRef: result.sessionRef,
        };
      },
    };
  }

  return new RelaycastFactoryFleetEmitter();
}
