import type { ProvisionedRelayFileAccess } from "./relay-file-access.js";

export type RelayContainerMode = "host" | "container";

export interface RelayAgentEnvironmentCreateOptions {
  aiProvider?: string;
  containerMode?: RelayContainerMode;
  mountPath?: string;
  syncIntervalSeconds?: number;
}

export interface RelayAgentToolDefinition {
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RelayAgentFuseMountConfig {
  enabled: boolean;
  mountPath: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RelayAgentEnvironmentOutput {
  env: Record<string, string>;
  tools: RelayAgentToolDefinition[];
  fuseMount: RelayAgentFuseMountConfig;
}

export class RelayAgentEnvironment {
  create(
    access: ProvisionedRelayFileAccess,
    options: RelayAgentEnvironmentCreateOptions = {},
  ): RelayAgentEnvironmentOutput {
    const containerMode = options.containerMode ?? "host";
    const mountPath =
      options.mountPath ?? (containerMode === "container" ? "/workspace" : "/project");
    const syncIntervalSeconds = `${options.syncIntervalSeconds ?? 1}s`;

    const env: Record<string, string> = {
      RELAYFILE_URL: access.relayfileUrl,
      RELAYFILE_TOKEN: access.token,
      RELAYFILE_WORKSPACE: access.workspace,
      RELAYFILE_WORKSPACE_ID: access.workspace,
      RELAYFILE_WS_URL: access.wsUrl,
      RELAY_AGENT_NAME: access.agentName,
      RELAY_AGENT_SCOPES: access.scopes.join(" "),
      RELAY_DOTFILE_RULES: access.dotfileRules.join(","),
      RELAY_CONTAINER_MODE: containerMode,
    };

    if (options.aiProvider) {
      env.RELAY_AI_PROVIDER = options.aiProvider;
    }

    const fuseMount: RelayAgentFuseMountConfig = {
      enabled: true,
      mountPath,
      command: "relayfile-mount",
      args: [
        "--base-url",
        access.relayfileUrl,
        "--workspace",
        access.workspace,
        "--local-dir",
        mountPath,
        "--token",
        access.token,
        "--interval",
        syncIntervalSeconds,
      ],
      env: {
        RELAYFILE_URL: access.relayfileUrl,
        RELAYFILE_TOKEN: access.token,
        RELAYFILE_WORKSPACE: access.workspace,
        RELAYFILE_WORKSPACE_ID: access.workspace,
      },
    };

    return {
      env,
      tools: [
        {
          name: "relayfile_mount",
          description: "Mounts the provisioned Relayfile workspace into the agent runtime.",
          command: fuseMount.command,
          args: [...fuseMount.args],
          env: { ...fuseMount.env },
        },
        {
          name: "relayfile_export_patch",
          description: "Exports the current Relayfile workspace as a patch.",
          command: "curl",
          args: [
            "-fsSL",
            "-H",
            `Authorization: Bearer ${access.token}`,
            `${access.relayfileUrl}/v1/workspaces/${encodeURIComponent(access.workspace)}/fs/export?format=patch`,
          ],
          env: {
            RELAYFILE_TOKEN: access.token,
          },
        },
      ],
      fuseMount,
    };
  }
}
