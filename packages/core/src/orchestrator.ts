/**
 * Orchestrator service — fire-and-forget workflow launcher.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { Daytona } from "@daytonaio/sdk";
import {
  generatePatch,
  downloadAndApplyPatch,
  type SandboxLike,
} from "./code-sync/index.js";
import { getCliCredentials } from "./auth/cli-credentials.js";
import {
  launchOrchestratorSandbox,
  resolveCredentialProxyConfig,
} from "./bootstrap/launcher.js";
import {
  buildCredentialBundle,
  resolveDaytonaAuthCredentials,
  type CredentialBundle,
  type DaytonaAuthCredentials,
} from "./auth/credentials.js";
import { mintS3Credentials } from "./auth/s3-credentials.js";
import {
  mintCredentialProxyToken,
  resolveProxyProviderFromCredentialProvider,
} from "./auth/proxy-token.js";
import type { CloudRelayYamlConfig } from "./types/workflows.js";

type InputType = "yaml" | "typescript" | "python" | "config";
type OrchestratorCloudApiCredentials = Pick<
  CredentialBundle,
  | "cloudApiUrl"
  | "cloudApiAccessToken"
  | "cloudApiRefreshToken"
  | "cloudApiAccessTokenExpiresAt"
>;

export interface OrchestratorOptions extends OrchestratorCloudApiCredentials {
  /** Daytona auth credentials — either { apiKey } or { jwtToken, organizationId }.
   *  Required when calling run(). Optional for syncBack-only usage. */
  daytonaAuth?: DaytonaAuthCredentials;
  relayfileUrl?: string;
  relayAuthUrl?: string;
  relayAuthApiKey?: string;
}

type RunOptions =
  | {
      codeSyncDir?: string;
      userId: string;
      credentialEncryptionKey: string;
      interactive?: boolean;
    }
  | {
      codeSyncDir?: string;
      userId?: undefined;
      credentialEncryptionKey?: undefined;
      interactive?: boolean;
    };

type Sandbox = Awaited<ReturnType<Daytona["create"]>>;

export class Orchestrator {
  private inputType: InputType;
  private filePath?: string;
  private config?: CloudRelayYamlConfig;
  private daytonaAuth?: DaytonaAuthCredentials;
  private cloudApiCredentials: OrchestratorCloudApiCredentials;
  private relayfileCredentials: {
    relayfileUrl?: string;
    relayAuthUrl?: string;
    relayAuthApiKey?: string;
  };

  constructor(input: string | CloudRelayYamlConfig, options?: OrchestratorOptions) {
    this.daytonaAuth = options?.daytonaAuth;
    this.cloudApiCredentials = {
      cloudApiUrl: options?.cloudApiUrl,
      cloudApiAccessToken: options?.cloudApiAccessToken,
      cloudApiRefreshToken: options?.cloudApiRefreshToken,
      cloudApiAccessTokenExpiresAt: options?.cloudApiAccessTokenExpiresAt,
    };
    this.relayfileCredentials = {
      relayfileUrl:
        options?.relayfileUrl
        ?? process.env.RelayfileUrl
        ?? process.env.RELAYFILE_URL,
      relayAuthUrl:
        options?.relayAuthUrl
        ?? process.env.RELAYAUTH_URL
        ?? process.env.RelayauthUrl
        ?? "https://api.relayauth.dev",
      relayAuthApiKey:
        options?.relayAuthApiKey
        ?? process.env.RELAYAUTH_API_KEY
        ?? process.env.WEB_RELAYAUTH_API_KEY,
    };

    if (typeof input === "string") {
      this.filePath = path.resolve(input);
      const ext = path.extname(this.filePath).toLowerCase();
      switch (ext) {
        case ".yaml":
        case ".yml":
          this.inputType = "yaml";
          break;
        case ".ts":
        case ".tsx":
          this.inputType = "typescript";
          break;
        case ".py":
          this.inputType = "python";
          break;
        default:
          throw new Error(`Unsupported file type: ${ext}`);
      }
    } else {
      this.inputType = "config";
      this.config = input;
    }
  }

  private buildLaunchCredentialBundle(
    params: Omit<
      Parameters<typeof buildCredentialBundle>[0],
      keyof OrchestratorCloudApiCredentials
    >
  ): CredentialBundle {
    return buildCredentialBundle({
      ...params,
      ...this.cloudApiCredentials,
    });
  }

  /**
   * Fire-and-forget: set up infrastructure, launch workflow in bootstrap
   * sandbox, and return immediately.
   */
  async run(
    options?: RunOptions
  ): Promise<{ runId: string; sandboxId: string; sandbox: Sandbox }> {
    const runId = crypto.randomUUID();
    const userId = options?.userId;

    if (!userId) {
      throw new Error("userId is required to retrieve CLI credentials");
    }

    // TODO(code-sync): codeSyncDir is temporarily unsupported while bootstrap
    // handles file-based input separately.
    if (options?.codeSyncDir) {
      console.warn("codeSyncDir is not supported in bootstrap run path yet");
    }

    const roleArn = process.env.STS_ROLE_ARN;
    const bucket = process.env.S3_BUCKET;
    if (!roleArn) {
      throw new Error("Missing required env var: STS_ROLE_ARN");
    }
    if (!bucket) {
      throw new Error("Missing required env var: S3_BUCKET");
    }

    const credentialEncryptionKey = options?.credentialEncryptionKey;
    if (!credentialEncryptionKey) {
      throw new Error(
        "credentialEncryptionKey is required to retrieve CLI credentials"
      );
    }

    // Compute workflowConfig once to avoid double file reads
    const workflowConfig = this.inputType === "config"
      ? JSON.stringify(this.config)
      : this.inputType === "yaml"
        ? JSON.stringify(parseYaml(readFileSync(this.filePath!, "utf-8")))
        : undefined;

    // Resolve credential provider from workflow config (e.g. codex → openai)
    const { resolveCredentialProvider } = await import("./auth/cli-credentials.js");
    const provider = workflowConfig
      ? resolveCredentialProvider(workflowConfig)
      : "anthropic";

    const credentialProxyUrl = process.env.CREDENTIAL_PROXY_URL?.trim();
    const credentialProxyJwtSecret = process.env.CREDENTIAL_PROXY_JWT_SECRET?.trim();
    const proxyProvider = resolveProxyProviderFromCredentialProvider(provider);
    const useCredentialProxy = Boolean(
      credentialProxyUrl && credentialProxyJwtSecret && proxyProvider
    );
    const cliCredentials = useCredentialProxy
      ? ""
      : await getCliCredentials(
          userId,
          provider,
          credentialEncryptionKey
        );
    const s3Credentials = await mintS3Credentials({
      userId,
      runId,
      roleArn,
      bucket,
    });

    // For ts/py files, read the source so the launcher can upload it to the sandbox
    const workflowFileContent =
      this.inputType === "typescript" || this.inputType === "python"
        ? readFileSync(this.filePath!, "utf-8")
        : undefined;
    const workflowFileName =
      this.filePath && workflowFileContent
        ? path.basename(this.filePath)
        : undefined;

    if (!this.daytonaAuth) {
      throw new Error("daytonaAuth is required — pass it in the Orchestrator constructor options");
    }
    const resolvedAuth = resolveDaytonaAuthCredentials(this.daytonaAuth);
    const credentialProxyTokens =
      useCredentialProxy && proxyProvider && credentialProxyJwtSecret
        ? {
            [proxyProvider]: await mintCredentialProxyToken({
              subject: process.env.RELAY_WORKSPACE_ID ?? userId,
              provider: proxyProvider,
              credentialId: userId,
              secret: credentialProxyJwtSecret,
              ttlSeconds: 2 * 60 * 60,
            }),
          }
        : undefined;
    const credentialBundle = this.buildLaunchCredentialBundle({
      s3Credentials,
      cliCredentials,
      workspaceId: process.env.RELAY_WORKSPACE_ID ?? "",
      relayApiKey: process.env.RELAY_API_KEY ?? "",
      // buildCredentialBundle defaults this to DEFAULT_RELAY_BASE_URL when
      // blank. Standalone orchestrator callers can override via env.
      relayBaseUrl: process.env.RELAY_BASE_URL,
      runId,
      userId,
      credentialProxyUrl: useCredentialProxy ? credentialProxyUrl : undefined,
      credentialProxyTokens,
      daytonaApiKey: "apiKey" in resolvedAuth ? resolvedAuth.apiKey : undefined,
      daytonaJwtToken: "jwtToken" in resolvedAuth ? resolvedAuth.jwtToken : undefined,
      daytonaOrganizationId: "organizationId" in resolvedAuth ? resolvedAuth.organizationId : undefined,
      callbackUrl: process.env.CALLBACK_URL,
      callbackToken: process.env.CALLBACK_TOKEN,
      workflowConfig,
    });
    const credentialProxy = resolveCredentialProxyConfig();

    const { sandboxId } = await launchOrchestratorSandbox({
      credentialBundle,
      runId,
      ...credentialProxy,
      relayfileUrl: this.relayfileCredentials.relayfileUrl ?? "",
      relayAuthUrl: this.relayfileCredentials.relayAuthUrl ?? "",
      relayAuthApiKey: this.relayfileCredentials.relayAuthApiKey ?? "",
      fileType: this.inputType,
      workflowConfig,
      workflowFileContent,
      workflowFileName,
      interactive: options?.interactive,
    });

    const daytona = new Daytona(resolvedAuth);
    const sandbox = await daytona.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Unable to resolve launched sandbox: ${sandboxId}`);
    }

    return { runId, sandboxId, sandbox };
  }

  /**
   * Generate a patch from agent changes on the sandbox and download+apply it locally.
   * Call this after the workflow completes.
   */
  async syncBack(
    sandbox: SandboxLike,
    localRootDir: string,
    remotePath: string = "/project"
  ): Promise<{ applied: boolean; output: string; hasChanges: boolean }> {
    const { hasChanges } = await generatePatch(sandbox, remotePath);
    if (!hasChanges) {
      return { applied: false, output: "No changes detected", hasChanges: false };
    }
    const { applied, output } = await downloadAndApplyPatch(sandbox, localRootDir);
    return { applied, output, hasChanges: true };
  }
}
