import {
  buildRuntimeEnv,
  loadCredentialOrThrow,
  mintRelayfileToken,
  normalizeMountPaths,
  type CloudAgentBoxDeps,
  type CloudAgentBoxInput,
  type CloudAgentWorkspaceSource,
} from "./box-manager";
import type { WarmStepContext } from "./warm-step-runner";
import type { CloudAgentBoxWarmJobRow } from "./warm-job-store";

/**
 * Cloud-agent box warm context reconstruction (issue #1384, slice 3). Each step
 * rebuilds its full WarmStepContext from the durable job row + Daytona sandbox
 * alone (#1445 rule) — credentials/tokens resolved fresh, sandbox re-fetched by id.
 */
export function warmJobInput(job: CloudAgentBoxWarmJobRow): CloudAgentBoxInput {
  const request = job.request ?? {};
  return {
    auth: { userId: job.userId, workspaceId: job.workspaceId, organizationId: job.organizationId },
    cloudAgentId: job.cloudAgentId,
    workspaceToken: request.workspaceToken ?? null,
    mountPaths: request.mountPaths,
    workspaceSource: (request.workspaceSource as CloudAgentWorkspaceSource | null | undefined) ?? undefined,
    workspaceKey: request.workspaceKey,
    brokerName: request.brokerName,
  };
}

export async function buildWarmStepContext(
  deps: CloudAgentBoxDeps,
  job: CloudAgentBoxWarmJobRow,
): Promise<WarmStepContext> {
  const input = warmJobInput(job);
  const credential = await loadCredentialOrThrow(deps, input);
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
  const daytona = deps.createDaytonaClient();
  const sandbox = job.sandboxId ? await daytona.get(job.sandboxId) : null;
  const home = sandbox ? (await sandbox.getUserHomeDir?.()) ?? "/home/daytona" : "/home/daytona";
  const { envVars, credentialSecret } = await buildRuntimeEnv(deps, input, credential, relayfileToken, mountPaths);
  const apiKey = sandbox ? deps.deriveBrokerApiKey(deps.getBrokerKeySecret(), sandbox.id) : "";
  return { deps, daytona, input, credential, mountPaths, relayfileToken, apiKey, home, envVars, credentialSecret, sandbox, createdSandboxId: null, result: null };
}
