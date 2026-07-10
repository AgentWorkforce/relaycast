import {
  createPlatformClient,
  type PlatformClient,
  type WorkspacePolicy,
} from "@cloud/platform";

type WorkspacePolicyLoader = (
  workspaceId: string,
) => Promise<WorkspacePolicy>;

let workspacePolicyLoader: WorkspacePolicyLoader | null = null;
let platformClientPromise: Promise<PlatformClient> | null = null;

export async function getWorkspacePolicy(
  workspaceId: string,
): Promise<WorkspacePolicy> {
  if (workspacePolicyLoader) {
    return workspacePolicyLoader(workspaceId);
  }

  const client = await getPlatformClient();
  return client.getWorkspacePolicy(workspaceId);
}

export function __setWorkspacePolicyLoaderForTesting(
  loader: WorkspacePolicyLoader,
): void {
  workspacePolicyLoader = loader;
}

export async function __resetWorkspacePolicyStateForTesting(): Promise<void> {
  workspacePolicyLoader = null;

  if (!platformClientPromise) {
    return;
  }

  const client = await platformClientPromise.catch(() => null);
  platformClientPromise = null;
  await client?.close?.();
}

async function getPlatformClient(): Promise<PlatformClient> {
  if (!platformClientPromise) {
    platformClientPromise = Promise.resolve(
      createPlatformClient(requireProcessEnv("DATABASE_URL")),
    );
  }

  return platformClientPromise;
}

function requireProcessEnv(name: string): string {
  const value = typeof process !== "undefined" ? process.env[name]?.trim() : "";
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
