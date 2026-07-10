import type { WorkflowStep, AgentDefinition, AgentPreset } from '@relayflows/core';
import type { CredentialBundle } from '../auth/credentials.js';
import { buildStepCredentials, credentialsToEnv } from '../auth/credentials.js';
import {
  applyAnthropicOauthTokenEnv,
  extractProviderCredentials,
  mountCliCredentials,
  resolveCredentialProviderFromCli,
  resolveProxyCredentialEnv,
} from '../auth/cli-credentials.js';
import { CLI_AUTH_CONFIG } from '@agent-relay/config/cli-auth-config';
import { ScopedS3Client } from '../storage/client.js';
import { LogStreamer } from '../storage/log-streamer.js';
import { buildMetadata, writeMetadata } from '../storage/metadata.js';
import { DaytonaRuntime, type DaytonaRuntimeOptions } from '../runtime/daytona.js';
import type { RuntimeHandle, WorkflowRuntime, ProcessBackend, ProcessEnvironment } from '../runtime/types.js';
import { buildAgentCommand } from './presets.js';
import { isValidWorkspaceId } from '../workspace/id.js';
import {
  SandboxOrchestrator,
  type RelayfileMountHandle,
} from './sandbox-orchestrator.js';
import type { SessionEventClient } from '../session/types.js';
import { resolveProxyProviderFromCli } from '../auth/proxy-token.js';

// ── Auth error detection ──────────────────────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
  /oauth token has expired/i,
  /invalid api key/i,
  /authentication_error/i,
  /please run \/login/i,
  /token has expired/i,
  /unauthorized.*please.*login/i,
];

function isAuthError(output: string | undefined): boolean {
  if (!output) return false;
  return AUTH_ERROR_PATTERNS.some((p) => p.test(output));
}

const ARTIFACT_FILE_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;
const ARTIFACT_TOTAL_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
const STEP_RELAYFILE_INITIAL_SYNC_IDLE_TIMEOUT_MS = 300_000;
const RESOLVE_BROKER_BINARY_SCRIPT = [
  "const{createRequire}=require('module'),{existsSync}=require('fs'),{dirname,join}=require('path')",
  "const r=createRequire(join(process.cwd(),'package.json'))",
  "let d=dirname(r.resolve('@agent-relay/sdk'))",
  "const n='agent-relay-broker-'+process.platform+'-'+process.arch+(process.platform==='win32'?'.exe':'')",
  "let p=''",
  "for(let i=0;i<10&&!p;i++){const c=join(d,'bin',n);if(existsSync(c))p=c;const u=dirname(d);if(u===d)break;d=u}",
  "if(!p)process.exit(1)",
  "process.stdout.write(p)",
].join(';');

// ─────────────────────────────────────────────────────────────────────────────

interface SandboxedStepExecutorBaseOptions {
  credentials: CredentialBundle;
  s3: ScopedS3Client;
  relayfileUrl: string;
  relayfileToken: string;
  relayfileWorkspaceId?: string;
  orchestratorRuntimeHandle?: RuntimeHandle;
  codeMountPath?: string;
  envSecrets?: Record<string, string>;
  sessionEvents?: SessionEventClient;
}

export interface DaytonaStepExecutorOptions extends SandboxedStepExecutorBaseOptions {
  runtime: WorkflowRuntime;
}

/** @deprecated Pass `runtime` instead of `daytona`/`snapshot`. */
interface LegacyDaytonaStepExecutorOptions extends SandboxedStepExecutorBaseOptions {
  daytona: DaytonaRuntimeOptions['daytona'];
  snapshot?: string;
}

interface RelayAgentTokenRecord {
  token?: string;
  scopes?: string[];
}

interface ProjectFileEntry {
  size: number;
  mtime: number;
}

type ProjectFileMap = Map<string, ProjectFileEntry>;

interface ArtifactPropagationSkip {
  path: string;
  reason: string;
  detail?: string;
}

interface ArtifactPropagationMetadata {
  propagated: boolean;
  copied: string[];
  skipped: ArtifactPropagationSkip[];
  warnings: string[];
  reason?: string;
}

class ArtifactPropagationFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPropagationFatalError';
  }
}

export class SandboxedStepExecutor implements ProcessBackend {
  private readonly codeMountPath: string;
  private readonly runtime: WorkflowRuntime;
  private readonly credentials: CredentialBundle;
  private readonly s3: ScopedS3Client;
  private readonly relayfileUrl: string;
  private readonly relayfileToken: string;
  private readonly relayfileWorkspaceId: string;
  private readonly orchestratorRuntimeHandle?: RuntimeHandle;
  private readonly envSecrets: Record<string, string>;
  private readonly sessionEvents?: SessionEventClient;
  private readonly artifactOwner = new Map<string, string>();
  private readonly sandboxOrchestrator: SandboxOrchestrator<RuntimeHandle>;
  private sandboxNameSequence = 0;

  constructor(options: DaytonaStepExecutorOptions | LegacyDaytonaStepExecutorOptions) {
    this.runtime = 'runtime' in options
      ? options.runtime
      : new DaytonaRuntime({ daytona: options.daytona, snapshot: options.snapshot });
    this.credentials = options.credentials;
    this.s3 = options.s3;
    this.codeMountPath = options.codeMountPath ?? '/home/daytona/project';
    this.relayfileUrl = stripTrailingSlash(options.relayfileUrl);
    this.relayfileToken = options.relayfileToken.trim();
    const explicitWorkspaceId = options.relayfileWorkspaceId?.trim() ?? '';
    const bundledWorkspaceId = this.credentials.workspaceId.trim();
    this.relayfileWorkspaceId = explicitWorkspaceId || bundledWorkspaceId;
    this.orchestratorRuntimeHandle = options.orchestratorRuntimeHandle;
    this.envSecrets = options.envSecrets ?? {};
    this.sessionEvents = options.sessionEvents;
    this.sandboxOrchestrator = new SandboxOrchestrator({
      provision: (launchOptions) => this.runtime.launch({
        label: launchOptions?.label,
        name: launchOptions?.name,
        labels: launchOptions?.labels,
        workdir: launchOptions?.workdir,
        env: launchOptions?.env,
        createTimeoutSeconds: launchOptions?.createTimeoutSeconds,
      }),
      runScript: (handle, runOptions) => this.runtime.exec(handle, runOptions.command, {
        cwd: runOptions.cwd,
        env: runOptions.env,
        timeoutMs: runOptions.timeoutMs,
      }),
      uploadBundle: async (handle, files) => {
        for (const file of files) {
          await this.runtime.uploadFile(handle, file.source, file.destination);
        }
      },
      teardown: (handle) => this.runtime.destroy(handle),
    });

    if (!this.relayfileUrl) {
      throw new Error('relayfileUrl is required');
    }
    if (!this.relayfileToken) {
      throw new Error('relayfileToken is required');
    }
    if (!isValidWorkspaceId(this.relayfileWorkspaceId)) {
      throw new Error('relayfileWorkspaceId must be a unified rw_ workspace ID');
    }
  }

  async createEnvironment(label: string): Promise<ProcessEnvironment> {
    const self = this;
    const handle = await this.createRuntimeHandle(label);
    const sandboxHome = await this.getRuntimeHome(handle);

    // Mount relayfile for code sync
    const relayfileMount = await this.startRelayfileMount(handle, sandboxHome);

    // Mount CLI credentials for all available providers
    const allProviders = Object.keys(CLI_AUTH_CONFIG) as Array<keyof typeof CLI_AUTH_CONFIG>;
    for (const provider of allProviders) {
      const providerCredentials = extractProviderCredentials(
        this.credentials.cliCredentials,
        provider,
      );
      try {
        await mountCliCredentials(
          this.createCredentialMountTarget(handle),
          sandboxHome,
          providerCredentials,
          provider,
        );
      } catch {
        // Provider credentials may not be present — skip silently
      }
    }

    // Mount cloud auth file
    const stepEnv = this.buildStepEnv(handle.id);
    await this.mountCloudAuthFile(handle, sandboxHome, stepEnv);

    // Ensure the working directory exists and is a git repo
    await this.executeRuntimeCommand(
      handle,
      `mkdir -p ${shellEscape(this.codeMountPath)} && cd ${shellEscape(this.codeMountPath)} && git init -q 2>/dev/null || true`,
      { cwd: sandboxHome },
    );

    return {
      id: handle.id,
      homeDir: sandboxHome,

      async exec(command, opts) {
        const execOpts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {};
        if (opts?.cwd) execOpts.cwd = opts.cwd;
        if (opts?.env) execOpts.env = opts.env;
        if (opts?.timeoutSeconds) execOpts.timeoutMs = opts.timeoutSeconds * 1000;
        return self.executeRuntimeCommand(handle, command, execOpts);
      },

      async uploadFile(content, remotePath) {
        await self.runtime.uploadFile(handle, content, remotePath);
      },

      async destroy() {
        await self.flushRelayfileMount(handle, sandboxHome).catch(() => {});
        await self.stopRelayfileMount(handle, sandboxHome, relayfileMount).catch(() => {});
        await self.disposeRuntime(handle).catch(() => {});
      },
    };
  }

  // DEPRECATED: This method reimplements broker logic (MCP wiring, CLI flags, auth).
  // Use createEnvironment() instead — the broker builds a fully-configured command
  // and calls env.exec(). See packages/core/docs/sandbox-provider-design.md.
  async executeAgentStep(
    step: WorkflowStep,
    agentDef: AgentDefinition,
    resolvedTask: string,
    timeoutMs?: number
  ): Promise<string> {
    const startedAt = new Date().toISOString();
    let handle: RuntimeHandle | null = null;
    let sandboxHome = '/home/daytona';
    let relayfileMount: RelayfileMountHandle | null = null;
    let logStreamer: LogStreamer | null = null;
    let commandResult: { output: string; exitCode: number } | null = null;
    let preset: AgentPreset = 'lead';
    let baselineFiles: ProjectFileMap | null = null;
    let artifactPropagation: ArtifactPropagationMetadata | undefined;
    const agentName = agentDef.name ?? step.agent ?? step.name;

    try {
      handle = await this.createRuntimeHandle(step.name);
      const sandboxId = handle.id;

      await this.sessionEvents?.emit({
        runId: this.credentials.runId,
        eventType: 'sandbox_created',
        stepName: step.name,
        sandboxId,
      }).catch(() => {});

      sandboxHome = await this.getRuntimeHome(handle);
      const agentRelayfileToken = this.resolveRelayfileTokenForAgent(agentName);
      const preparedWithoutRelayfile = await this.prepareFreshStepWorkspace(handle, step.name);
      if (!preparedWithoutRelayfile) {
        relayfileMount = await this.startRelayfileMount(handle, sandboxHome, agentRelayfileToken);
      }

      const provider = resolveCredentialProviderFromCli(agentDef.cli);
      const proxyProvider = resolveProxyProviderFromCli(agentDef.cli);
      const proxyUrl = this.credentials.credentialProxyUrl?.trim();
      const proxyToken = proxyProvider
        ? this.credentials.credentialProxyTokens?.[proxyProvider]
        : undefined;

      if (proxyUrl && proxyProvider && proxyToken) {
        // Proxy-backed agents receive runtime env only; raw provider files stay out of the sandbox.
      } else {
        const providerCredentials = extractProviderCredentials(
          this.credentials.cliCredentials,
          provider,
        );
        await mountCliCredentials(
          this.createCredentialMountTarget(handle),
          sandboxHome,
          providerCredentials,
          provider,
        );
      }

      const hasCli = await this.executeRuntimeCommand(handle, `which ${agentDef.cli} 2>/dev/null`);
      if (hasCli.exitCode !== 0) {
        await this.ensureCliInstalled(handle, provider);
      }

      // Ensure the working directory exists and is a git repo (required by some CLIs like codex)
      await this.executeRuntimeCommand(
        handle,
        `mkdir -p ${shellEscape(this.codeMountPath)} && cd ${shellEscape(this.codeMountPath)} && git init -q 2>/dev/null || true`,
        { cwd: sandboxHome },
      );

      const stepEnv = this.buildStepEnv(sandboxId, agentRelayfileToken);
      await this.mountCloudAuthFile(handle, sandboxHome, stepEnv);

      preset = agentDef.preset ?? 'lead';
      let { command, env: presetEnv } = await buildAgentCommand(
        agentDef.cli,
        preset,
        resolvedTask,
        step.name,
        agentDef.constraints?.model,
      );

      // Codex in a strongly isolated runtime (for example Daytona) can bypass
      // its own sandbox and skip the git repo check.
      if (
        agentDef.cli === 'codex'
        && this.runtime.capabilities.isolation === 'strong'
        && !command.includes('dangerously-bypass')
      ) {
        command = command.replace(/^codex\s+exec\b/, 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
      }

      const mcp = await this.getMcpConfigForAgent(handle, {
        stepName: step.name,
        cli: agentDef.cli,
        agentName,
        relayApiKey: stepEnv.RELAY_API_KEY,
        // StepCredentials now carries relayBaseUrl threaded from the cloud
        // request (defaulting to DEFAULT_RELAY_BASE_URL when unset). The
        // envSecrets / process.env fallbacks are retained only as a legacy
        // escape hatch for callers that bypass buildStepCredentials.
        baseUrl:
          stepEnv.RELAY_BASE_URL
          || this.envSecrets.RELAY_BASE_URL
          || process.env.RELAY_BASE_URL,
        workspaceId: this.relayfileWorkspaceId,
        cwd: this.codeMountPath,
        sandboxHome,
      });
      if (mcp.args.length > 0) {
        command = `${command} ${mcp.args.map(shellEscape).join(' ')}`;
      }

      const mergedEnv = {
        ...stepEnv,
        ...(presetEnv ?? {}),
      };
      const proxyEnv = proxyUrl && proxyToken
        ? resolveProxyCredentialEnv(agentDef.cli, proxyUrl, proxyToken)
        : {};
      const finalEnv = { ...mergedEnv, ...this.envSecrets, ...proxyEnv };

      baselineFiles = await this.listProjectFiles(handle).catch((err) => {
        const warning = `[executor] artifact-propagation-warning: step "${step.name}" baseline failed: ${this.formatError(err)}`;
        console.warn(warning);
        artifactPropagation = {
          propagated: false,
          copied: [],
          skipped: [],
          warnings: [warning],
          reason: 'baseline-failed',
        };
        return null;
      });

      logStreamer = new LogStreamer(this.s3, sandboxId);
      await logStreamer.start();

      await this.sessionEvents?.emit({
        runId: this.credentials.runId,
        eventType: 'step_started',
        stepName: step.name,
        sandboxId,
      }).catch(() => {});

      commandResult = await this.runCommand(
        handle,
        command,
        finalEnv,
        this.codeMountPath,
        logStreamer,
        timeoutMs,
      );

      if (commandResult.exitCode !== 0) {
        throw new Error(`Agent step "${step.name}" exited with code ${commandResult.exitCode}`);
      }

      if (baselineFiles) {
        artifactPropagation = await this.copyArtifactsToOrchestrator(handle, step.name, baselineFiles)
          .catch((err) => {
            if (err instanceof ArtifactPropagationFatalError) {
              throw err;
            }
            const warning = `[executor] artifact-propagation-warning: step "${step.name}" copy failed: ${this.formatError(err)}`;
            console.warn(warning);
            return {
              propagated: false,
              copied: [],
              skipped: [],
              warnings: [warning],
              reason: 'copy-failed',
            };
          });
        if (artifactPropagation.warnings.length > 0) {
          await this.writeArtifactPropagationWarning(
            step,
            sandboxId,
            preset,
            artifactPropagation.warnings,
          ).catch(() => {});
        }
      }

      if (relayfileMount) {
        await this.stopRelayfileMount(handle, sandboxHome, relayfileMount, agentRelayfileToken);
        relayfileMount = null;
      }
      await logStreamer.finish();

      await this.writeStepMetadata(step, sandboxId, preset, {
        startTime: startedAt,
        exitCode: commandResult.exitCode,
        output: commandResult.output,
        cli: agentDef.cli,
        artifactPropagation,
      });

      await this.sessionEvents?.emit({
        runId: this.credentials.runId,
        eventType: 'step_completed',
        stepName: step.name,
        sandboxId,
        payload: { exitCode: commandResult.exitCode },
      }).catch(() => {});

      return commandResult.output;
    } catch (err) {
      if (logStreamer) {
        await logStreamer.finish().catch(() => logStreamer!.abort().catch(() => {}));
      }

      if (handle) {
        const failureArtifactPropagation = commandResult?.exitCode !== undefined && commandResult.exitCode !== 0
          ? {
              propagated: false,
              copied: [],
              skipped: [],
              warnings: artifactPropagation?.warnings ?? [],
              reason: 'step-failed',
            }
          : artifactPropagation;
        await this.writeStepMetadata(step, handle.id, preset, {
          startTime: startedAt,
          exitCode: commandResult?.exitCode,
          error: this.formatError(err),
          output: commandResult?.output,
          cli: agentDef.cli,
          artifactPropagation: failureArtifactPropagation,
        }).catch(() => {});

        await this.sessionEvents?.emit({
          runId: this.credentials.runId,
          eventType: 'step_failed',
          stepName: step.name,
          sandboxId: handle.id,
          payload: { error: this.formatError(err) },
        }).catch(() => {});
      }

      // Detect auth errors and surface a clear, actionable message
      if (isAuthError(commandResult?.output)) {
        const provider = resolveCredentialProviderFromCli(agentDef.cli);
        throw new Error(
          `Agent "${step.name}" authentication failed: ${provider} credentials have expired. Run 'cloud connect ${provider}' to reconnect.`
        );
      }

      throw err;
    } finally {
      if (handle) {
        if (relayfileMount) {
          await this.stopRelayfileMount(
            handle,
            sandboxHome,
            relayfileMount,
            this.resolveRelayfileTokenForAgent(agentName),
          ).catch(() => {});
        }
        await this.sessionEvents?.emit({
          runId: this.credentials.runId,
          eventType: 'sandbox_disposed',
          stepName: step.name,
          sandboxId: handle.id,
        }).catch(() => {});
        await this.disposeRuntime(handle).catch(() => {});
      }
    }
  }

  async executeDeterministicStep(
    step: WorkflowStep,
    resolvedCommand: string,
    stepCwd?: string,
  ): Promise<{ output: string; exitCode: number }> {
    if (this.orchestratorRuntimeHandle) {
      const handle = this.orchestratorRuntimeHandle;
      const cwd = stepCwd || this.codeMountPath;
      const sandboxHome = await this.getRuntimeHome(handle);
      const startedAt = new Date().toISOString();
      const metadataKey = `${handle.id}-${step.name}`;
      let output = '';
      let exitCode = 0;
      try {
        const result = await this.sandboxOrchestrator.runScript(handle, {
          command: resolvedCommand,
          cwd,
          env: {
            ...this.buildStepEnv(handle.id),
            ...this.envSecrets,
          },
        });
        output = result.output;
        exitCode = result.exitCode ?? 1;

        // Flush file changes to relayfile so subsequent agent steps
        // (which create new sandboxes with fresh relayfile-mount pulls)
        // see the latest state.
        await this.flushRelayfileMount(handle, sandboxHome);

        await this.writeStepMetadata(step, metadataKey, 'deterministic', {
          startTime: startedAt,
          exitCode,
          output,
        });
        return { output, exitCode };
      } catch (err) {
        await this.writeStepMetadata(step, metadataKey, 'deterministic', {
          startTime: startedAt,
          exitCode,
          output,
          error: this.formatError(err),
        }).catch(() => {});
        throw err;
      }
    }

    const startedAt = new Date().toISOString();
    let handle: RuntimeHandle | null = null;
    let sandboxHome = '/home/daytona';
    let relayfileMount: RelayfileMountHandle | null = null;

    try {
      handle = await this.createRuntimeHandle(step.name);
      const sandboxId = handle.id;
      sandboxHome = await this.getRuntimeHome(handle);
      const preparedWithoutRelayfile = await this.prepareFreshStepWorkspace(handle, step.name);
      if (!preparedWithoutRelayfile) {
        relayfileMount = await this.startRelayfileMount(handle, sandboxHome);
      }

      const result = await this.sandboxOrchestrator.runScript(handle, {
        command: resolvedCommand,
        cwd: stepCwd || this.codeMountPath,
        env: {
          ...this.buildStepEnv(sandboxId),
          ...this.envSecrets,
        },
      });
      const output = result.output;
      const exitCode = result.exitCode ?? 1;

      if (relayfileMount) {
        await this.stopRelayfileMount(handle, sandboxHome, relayfileMount);
        relayfileMount = null;
      }

      await this.writeStepMetadata(step, sandboxId, 'deterministic', {
        startTime: startedAt,
        exitCode,
        output,
      });

      return { output, exitCode };
    } catch (err) {
      if (handle) {
        await this.writeStepMetadata(step, handle.id, 'deterministic', {
          startTime: startedAt,
          error: this.formatError(err),
        }).catch(() => {});
      }
      throw err;
    } finally {
      if (handle) {
        if (relayfileMount) {
          await this.stopRelayfileMount(handle, sandboxHome, relayfileMount).catch(() => {});
        }
        await this.disposeRuntime(handle).catch(() => {});
      }
    }
  }

  private async createRuntimeHandle(stepName: string): Promise<RuntimeHandle> {
    return this.sandboxOrchestrator.provision({
      label: stepName,
      name: buildStepSandboxName(stepName, this.credentials.runId, ++this.sandboxNameSequence),
      labels: { step: stepName },
      workdir: this.codeMountPath,
    });
  }

  private async prepareFreshStepWorkspace(
    handle: RuntimeHandle,
    stepName: string,
  ): Promise<boolean> {
    if (await this.isCodeMountPrepopulated(handle)) {
      console.log(`[executor] using pre-populated workspace for step "${stepName}"; skipping bidirectional relayfile bootstrap`);
      return true;
    }

    return this.seedStepWorkspaceFromOrchestrator(handle, stepName);
  }

  private async isCodeMountPrepopulated(handle: RuntimeHandle): Promise<boolean> {
    const result = await this.executeRuntimeCommand(
      handle,
      [
        `if [ -d ${shellEscape(this.codeMountPath)} ]`,
        `&& find ${shellEscape(this.codeMountPath)} -mindepth 1 -maxdepth 1`,
        "! -name '.git'",
        "! -name '.agent-relay'",
        "! -name '.relay'",
        "! -name '.skills'",
        "! -name '.trajectories'",
        "! -name '.relayfile-mount-state.json'",
        "! -name '..relayfile-mount-state.json.tmp-*'",
        "-print -quit | grep -q .; then printf 'populated'; fi",
      ].join(' '),
      { cwd: '/', timeoutMs: 10_000 },
    );

    return result.exitCode === 0 && result.output.trim() === 'populated';
  }

  private async seedStepWorkspaceFromOrchestrator(
    handle: RuntimeHandle,
    stepName: string,
  ): Promise<boolean> {
    const orchestratorHandle = this.orchestratorRuntimeHandle;
    if (!orchestratorHandle || orchestratorHandle.id === handle.id) {
      return false;
    }

    const archiveName = `agent-relay-step-seed-${sanitizeArtifactStepName(stepName)}-${sanitizeArtifactStepName(handle.id)}.tar.gz`;
    const orchestratorArchivePath = `/tmp/${archiveName}`;
    const stepArchivePath = `/tmp/${archiveName}`;

    const createResult = await this.executeRuntimeCommand(
      orchestratorHandle,
      [
        `mkdir -p ${shellEscape(remoteDirname(orchestratorArchivePath))}`,
        `cd ${shellEscape(this.codeMountPath)}`,
        [
          'tar',
          `--exclude=${shellEscape('./.agent-relay')}`,
          `--exclude=${shellEscape('./.agent-relay/*')}`,
          `--exclude=${shellEscape('*/.agent-relay')}`,
          `--exclude=${shellEscape('*/.agent-relay/*')}`,
          `--exclude=${shellEscape('./.relay')}`,
          `--exclude=${shellEscape('./.relay/*')}`,
          `--exclude=${shellEscape('*/.relay')}`,
          `--exclude=${shellEscape('*/.relay/*')}`,
          `--exclude=${shellEscape('./.skills')}`,
          `--exclude=${shellEscape('./.skills/*')}`,
          `--exclude=${shellEscape('*/.skills')}`,
          `--exclude=${shellEscape('*/.skills/*')}`,
          `--exclude=${shellEscape('./.trajectories')}`,
          `--exclude=${shellEscape('./.trajectories/*')}`,
          `--exclude=${shellEscape('*/.trajectories')}`,
          `--exclude=${shellEscape('*/.trajectories/*')}`,
          `--exclude=${shellEscape('./.relayfile.acl')}`,
          `--exclude=${shellEscape('./.relayfile-mount-state.json')}`,
          `--exclude=${shellEscape('./..relayfile-mount-state.json.tmp-*')}`,
          '-czf',
          shellEscape(orchestratorArchivePath),
          '.',
        ].join(' '),
      ].join(' && '),
      { cwd: this.codeMountPath, timeoutMs: STEP_RELAYFILE_INITIAL_SYNC_IDLE_TIMEOUT_MS },
    );
    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to archive orchestrator workspace for step "${stepName}": ${createResult.output}`);
    }

    let archive: Buffer | void;
    try {
      archive = await this.runtime.downloadFile(orchestratorHandle, orchestratorArchivePath);
    } finally {
      await this.executeRuntimeCommand(
        orchestratorHandle,
        `rm -f ${shellEscape(orchestratorArchivePath)}`,
        { cwd: this.codeMountPath },
      ).catch(() => {});
    }

    if (!Buffer.isBuffer(archive)) {
      throw new Error(`Failed to download orchestrator workspace archive for step "${stepName}"`);
    }

    await this.runtime.uploadFile(handle, archive, stepArchivePath);
    const extractResult = await this.executeRuntimeCommand(
      handle,
      [
        `mkdir -p ${shellEscape(this.codeMountPath)}`,
        `tar -xzf ${shellEscape(stepArchivePath)} -C ${shellEscape(this.codeMountPath)}`,
        `rm -f ${shellEscape(stepArchivePath)}`,
      ].join(' && '),
      { cwd: '/', timeoutMs: STEP_RELAYFILE_INITIAL_SYNC_IDLE_TIMEOUT_MS },
    );
    if (extractResult.exitCode !== 0) {
      throw new Error(`Failed to extract orchestrator workspace for step "${stepName}": ${extractResult.output}`);
    }

    console.log(`[executor] seeded step "${stepName}" workspace from orchestrator archive`);
    return true;
  }

  private buildStepEnv(
    sandboxId: string,
    relayfileToken: string = this.relayfileToken,
  ): Record<string, string> {
    const stepCredentials = buildStepCredentials(this.credentials, sandboxId);
    const stepEnv = credentialsToEnv(stepCredentials);
    const cloudApiUrl =
      stepEnv.CLOUD_API_URL
      || stepEnv.WORKFLOW_STORAGE_CLOUD_API_URL
      || this.credentials.cloudApiUrl
      || this.credentials.s3Credentials.cloudApiUrl
      || '';
    const cloudApiAccessToken =
      stepEnv.CLOUD_API_ACCESS_TOKEN
      || stepEnv.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN
      || this.credentials.cloudApiAccessToken
      || this.credentials.s3Credentials.cloudApiAccessToken
      || '';

    const env = {
      ...stepEnv,
      CLOUD_API_URL: cloudApiUrl,
      CLOUD_API_ACCESS_TOKEN: cloudApiAccessToken,
      RELAY_WORKSPACE_ID: this.relayfileWorkspaceId,
      RELAYFILE_URL: this.relayfileUrl,
      RELAYFILE_TOKEN: relayfileToken,
      RELAYFILE_WORKSPACE: this.relayfileWorkspaceId,
      RELAYFILE_WORKSPACE_ID: this.relayfileWorkspaceId,
    };
    applyAnthropicOauthTokenEnv(env, this.credentials.cliCredentials);
    return env;
  }

  private async startRelayfileMount(
    handle: RuntimeHandle,
    sandboxHome: string,
    relayfileToken: string = this.relayfileToken,
  ): Promise<RelayfileMountHandle> {
    return this.sandboxOrchestrator.startMount(
      handle,
      {
        baseUrl: this.relayfileUrl,
        workspaceId: this.relayfileWorkspaceId,
        localDir: this.codeMountPath,
        token: relayfileToken,
        interval: "3s",
        websocket: false,
      },
      { cwd: sandboxHome, initialSyncIdleTimeoutMs: STEP_RELAYFILE_INITIAL_SYNC_IDLE_TIMEOUT_MS },
    );
  }

  private async stopRelayfileMount(
    handle: RuntimeHandle,
    sandboxHome: string,
    mount: RelayfileMountHandle,
    relayfileToken: string = this.relayfileToken,
  ): Promise<void> {
    await this.sandboxOrchestrator.stopMount(
      handle,
      mount,
      {
        baseUrl: this.relayfileUrl,
        workspaceId: this.relayfileWorkspaceId,
        localDir: this.codeMountPath,
        token: relayfileToken,
      },
      { cwd: sandboxHome },
    );
  }

  private async flushRelayfileMount(
    handle: RuntimeHandle,
    sandboxHome: string,
    relayfileToken: string = this.relayfileToken,
  ): Promise<void> {
    await this.sandboxOrchestrator.flushMount(
      handle,
      {
        baseUrl: this.relayfileUrl,
        workspaceId: this.relayfileWorkspaceId,
        localDir: this.codeMountPath,
        token: relayfileToken,
      },
      { cwd: sandboxHome },
    );
  }

  private async listProjectFiles(handle: RuntimeHandle): Promise<ProjectFileMap> {
    const result = await this.executeRuntimeCommand(
      handle,
      [
        `cd ${shellEscape(this.codeMountPath)}`,
        [
          '(find .',
          '\\(',
          "-path './node_modules' -o -path './node_modules/*'",
          "-o -path './*/node_modules' -o -path './*/node_modules/*'",
          "-o -path './.git' -o -path './.git/*'",
          "-o -path './*/.git' -o -path './*/.git/*'",
          "-o -path './.agent-relay' -o -path './.agent-relay/*'",
          "-o -path './*/.agent-relay' -o -path './*/.agent-relay/*'",
          "-o -path './.relay' -o -path './.relay/*'",
          "-o -path './*/.relay' -o -path './*/.relay/*'",
          "-o -path './.skills' -o -path './.skills/*'",
          "-o -path './*/.skills' -o -path './*/.skills/*'",
          "-o -path './.trajectories' -o -path './.trajectories/*'",
          '\\)',
          '-prune',
          '-o -type f',
          "! -name '.relayfile.acl'",
          "! -name '.relayfile-mount-state.json'",
          "! -name '..relayfile-mount-state.json.tmp-*'",
          "-printf '%P\\t%s\\t%T@\\n'",
          '2>/dev/null)',
        ].join(' '),
      ].join(' && '),
      { cwd: this.codeMountPath, timeoutMs: 60_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list project files: ${result.output}`);
    }

    const files: ProjectFileMap = new Map();
    for (const line of result.output.split('\n')) {
      if (!line) continue;
      const [relativePath, sizeRaw, mtimeRaw] = line.split('\t');
      const size = Number(sizeRaw);
      const mtime = Number(mtimeRaw);
      if (!relativePath || !isSafeRelativeProjectPath(relativePath)) continue;
      if (isIgnoredProjectArtifactPath(relativePath)) continue;
      if (!Number.isFinite(size) || !Number.isFinite(mtime)) continue;
      files.set(relativePath, { size, mtime });
    }

    return files;
  }

  private async listGitChangedProjectFiles(handle: RuntimeHandle): Promise<Set<string> | null> {
    const script = [
      `cd ${shellEscape(this.codeMountPath)}`,
      'seen="$(mktemp)"',
      'emit_repo() {',
      '  repo="$1";',
      '  top="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" || return 0;',
      '  git -C "$top" rev-parse --verify HEAD >/dev/null 2>&1 || return 0;',
      '  case "$top" in "$PWD") prefix="" ;; "$PWD"/*) prefix="${top#$PWD/}/" ;; *) return 0 ;; esac;',
      '  if grep -Fx -- "$top" "$seen" >/dev/null 2>&1; then return 0; fi;',
      '  printf "%s\\n" "$top" >> "$seen";',
      '  printf "__AGENT_RELAY_GIT_REPO__\\t%s\\n" "$prefix";',
      // Detect changes the same way `git status --porcelain` does, but emit
      // clean paths: `diff --name-only HEAD` covers staged *and* unstaged
      // edits to tracked files (mount-independent, content-based vs the
      // committed baseline — immune to the #1499 mtime reset), while
      // `ls-files -o` enumerates untracked files individually (no porcelain
      // untracked-directory collapsing). `--no-renames` keeps the
      // destination path so it matches the final listing.
      '  { git -C "$top" diff --name-only --no-renames HEAD; git -C "$top" ls-files -o --exclude-standard; } | while IFS= read -r file_path; do',
      '    [ -n "$file_path" ] || continue;',
      '    printf "%s%s\\n" "$prefix" "$file_path";',
      '  done;',
      '}',
      'emit_repo .',
      `${[
        'find .',
        '\\(',
        "-path './node_modules' -o -path './node_modules/*'",
        "-o -path './*/node_modules' -o -path './*/node_modules/*'",
        "-o -path './.agent-relay' -o -path './.agent-relay/*'",
        "-o -path './*/.agent-relay' -o -path './*/.agent-relay/*'",
        "-o -path './.relay' -o -path './.relay/*'",
        "-o -path './*/.relay' -o -path './*/.relay/*'",
        '\\)',
        '-prune',
        '-o -name .git -print',
      ].join(' ')} | while IFS= read -r git_marker; do`,
      '  repo="${git_marker%/.git}";',
      '  emit_repo "$repo";',
      'done',
      'rm -f "$seen"',
    ].join('\n');
    const encodedScript = Buffer.from(script, 'utf8').toString('base64');
    const result = await this.executeRuntimeCommand(
      handle,
      `bash -lc "$(printf %s ${shellEscape(encodedScript)} | base64 -d)"`,
      { cwd: this.codeMountPath, timeoutMs: 60_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list git changed project files: ${result.output}`);
    }

    let sawRepository = false;
    const changed = new Set<string>();
    for (const line of result.output.split('\n')) {
      if (!line) continue;
      if (line.startsWith('__AGENT_RELAY_GIT_REPO__\t')) {
        sawRepository = true;
        continue;
      }
      if (!isSafeRelativeProjectPath(line)) continue;
      if (isIgnoredProjectArtifactPath(line)) continue;
      changed.add(line);
    }

    return sawRepository ? changed : null;
  }

  private async copyArtifactsToOrchestrator(
    handle: RuntimeHandle,
    stepName: string,
    baseline: ProjectFileMap,
  ): Promise<ArtifactPropagationMetadata> {
    const orchestratorHandle = this.orchestratorRuntimeHandle;
    if (!orchestratorHandle) {
      const warning = `[executor] artifact-propagation-warning: step "${stepName}" has no orchestrator runtime handle`;
      return {
        propagated: false,
        copied: [],
        skipped: [],
        warnings: [warning],
        reason: 'missing-orchestrator-handle',
      };
    }

    const finalFiles = await this.listProjectFiles(handle);
    if (baseline.size > 0 && finalFiles.size === 0) {
      throw new ArtifactPropagationFatalError(
        `[executor] artifact-propagation-fatal: step "${stepName}" baseline listed ${baseline.size} files but final listing was empty`,
      );
    }
    const gitChangedFiles = await this.listGitChangedProjectFiles(handle);
    const copied: string[] = [];
    const skipped: ArtifactPropagationSkip[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;

    for (const [relativePath, entry] of finalFiles) {
      if (gitChangedFiles) {
        if (!gitChangedFiles.has(relativePath)) {
          continue;
        }
      } else {
        const baselineEntry = baseline.get(relativePath);
        if (
          baselineEntry
          && baselineEntry.size === entry.size
          && baselineEntry.mtime === entry.mtime
        ) {
          continue;
        }
      }

      if (entry.size > ARTIFACT_FILE_SIZE_LIMIT_BYTES) {
        this.recordArtifactSkip(skipped, stepName, relativePath, 'size-cap', `${entry.size} bytes exceeds per-file cap`);
        continue;
      }
      if (totalBytes + entry.size > ARTIFACT_TOTAL_SIZE_LIMIT_BYTES) {
        this.recordArtifactSkip(skipped, stepName, relativePath, 'total-size-cap', `${totalBytes + entry.size} bytes exceeds per-step cap`);
        continue;
      }

      const sourcePath = joinRemotePath(this.codeMountPath, relativePath);
      let targetPath = joinRemotePath(this.codeMountPath, relativePath);
      let mirrorPath: string | null = null;
      let reservedRoot = false;

      try {
        const owner = this.artifactOwner.get(relativePath);
        if (owner && owner !== stepName) {
          targetPath = artifactTargetPath(this.codeMountPath, stepName, relativePath);
          warnings.push(`[executor] artifact-propagation-warning: step "${stepName}" redirected "${relativePath}" because "${owner}" already wrote it`);
        } else {
          if (shouldMirrorToStepArtifacts(stepName)) {
            mirrorPath = artifactTargetPath(this.codeMountPath, stepName, relativePath);
          }
          if (!owner) {
            this.artifactOwner.set(relativePath, stepName);
            reservedRoot = true;
          }
        }

        const buffer = await this.runtime.downloadFile(handle, sourcePath);
        if (!Buffer.isBuffer(buffer)) {
          if (reservedRoot && this.artifactOwner.get(relativePath) === stepName) {
            this.artifactOwner.delete(relativePath);
          }
          this.recordArtifactSkip(skipped, stepName, relativePath, 'download-empty', 'runtime returned no file contents');
          continue;
        }

        await this.executeRuntimeCommand(
          orchestratorHandle,
          `mkdir -p ${shellEscape(remoteDirname(targetPath))}`,
          { cwd: this.codeMountPath },
        );
        await this.runtime.uploadFile(orchestratorHandle, buffer, targetPath);
        if (mirrorPath && mirrorPath !== targetPath) {
          await this.executeRuntimeCommand(
            orchestratorHandle,
            `mkdir -p ${shellEscape(remoteDirname(mirrorPath))}`,
            { cwd: this.codeMountPath },
          );
          await this.runtime.uploadFile(orchestratorHandle, buffer, mirrorPath);
        }
        copied.push(targetPath === joinRemotePath(this.codeMountPath, relativePath) ? relativePath : pathRelativeToCodeMount(this.codeMountPath, targetPath));
        totalBytes += entry.size;
      } catch (err) {
        if (reservedRoot && this.artifactOwner.get(relativePath) === stepName) {
          this.artifactOwner.delete(relativePath);
        }
        this.recordArtifactSkip(skipped, stepName, relativePath, 'copy-failed', this.formatError(err));
      }
    }

    console.log(`[executor] propagated ${copied.length} files from step "${stepName}"`);
    return {
      propagated: true,
      copied,
      skipped,
      warnings,
    };
  }

  private async writeArtifactPropagationWarning(
    step: WorkflowStep,
    sandboxId: string,
    preset: string,
    warnings: string[],
  ): Promise<void> {
    for (const warning of warnings) {
      console.warn(`${warning} (sandbox=${sandboxId}, preset=${preset}, step=${step.name})`);
    }
  }

  private async remotePathExists(handle: RuntimeHandle, remotePath: string): Promise<boolean> {
    const result = await this.executeRuntimeCommand(
      handle,
      `test -e ${shellEscape(remotePath)}`,
      { cwd: this.codeMountPath },
    );
    return result.exitCode === 0;
  }

  private recordArtifactSkip(
    skipped: ArtifactPropagationSkip[],
    stepName: string,
    path: string,
    reason: string,
    detail?: string,
  ): void {
    const skip: ArtifactPropagationSkip = detail ? { path, reason, detail } : { path, reason };
    skipped.push(skip);
    console.warn(
      `[executor] artifact-skip: step "${stepName}" path "${path}" reason "${reason}"${detail ? ` (${detail})` : ''}`,
    );
  }

  private async runCommand(
    handle: RuntimeHandle,
    command: string,
    env: Record<string, string>,
    cwd: string,
    logStreamer: LogStreamer,
    timeoutMs?: number
  ): Promise<{ output: string; exitCode: number }> {
    const result = await this.sandboxOrchestrator.runScript(handle, {
      command,
      cwd,
      env,
      timeoutMs,
    });
    const output = result.output;

    if (output) {
      await logStreamer.write(output);
    }

    return {
      output,
      exitCode: result.exitCode ?? 1,
    };
  }

  private async writeStepMetadata(
    step: WorkflowStep,
    sandboxId: string,
    preset: string,
    overrides: {
      startTime?: string;
      exitCode?: number;
      error?: string;
      output?: string;
      cli?: string;
      artifactPropagation?: ArtifactPropagationMetadata;
    }
  ): Promise<void> {
    const metadata = buildMetadata(
      { name: step.name, agent: step.agent, preset, cli: overrides.cli },
      {
        sandboxId,
        preset,
        startTime: overrides.startTime,
        endTime: new Date().toISOString(),
        exitCode: overrides.exitCode,
        output: overrides.output,
        error: overrides.error,
      }
    );
    if (overrides.artifactPropagation) {
      (
        metadata as typeof metadata & {
          artifactPropagation: ArtifactPropagationMetadata;
        }
      ).artifactPropagation = overrides.artifactPropagation;
    }

    await writeMetadata(this.s3, sandboxId, metadata);
  }

  private async getMcpConfigForAgent(
    handle: RuntimeHandle,
    opts: {
      stepName: string;
      cli: string;
      agentName: string;
      relayApiKey: string;
      baseUrl?: string;
      workspaceId: string;
      cwd: string;
      sandboxHome: string;
    },
  ): Promise<{ args: string[]; sideEffectFiles: string[]; agentToken: string | null }> {
    if (!opts.relayApiKey) {
      throw new Error(
        `[${opts.stepName}] Cannot register relaycast MCP: RELAY_API_KEY is empty. ` +
          `This is a credential-wiring bug — mcp-args --register will reject empty keys and ` +
          `agents would silently spawn without MCP, then fail claiming relaycast is unavailable.`,
      );
    }

    // Resolve the broker binary from sandboxHome, where @agent-relay/sdk is
    // installed (see scripts/create-snapshot.ts). Running node from opts.cwd
    // (the user's mounted project) fails with ERR_MODULE_NOT_FOUND because
    // the SDK is not in the project's node_modules.
    //
    // Pass --base-url explicitly (not just via env) so the broker reaches
    // the same relaycast the RELAY_API_KEY was minted against. The public
    // default (https://api.relaycast.dev) works for production but breaks
    // staging/self-hosted where the cloud's `resolveRelaycastUrl()` points
    // elsewhere — relying on a broker-side default would silently target
    // the wrong backend and get rejected.
    const baseUrl = opts.baseUrl?.trim();
    const cliArgs = [
      '--cli', shellEscape(opts.cli),
      '--agent-name', shellEscape(opts.agentName),
      '--default-workspace', shellEscape(opts.workspaceId),
      '--cwd', shellEscape(opts.cwd),
    ];
    if (baseUrl) {
      cliArgs.push('--base-url', shellEscape(baseUrl));
    }
    const command = [
      `cd ${shellEscape(opts.sandboxHome)}`,
      '&&',
      `BROKER="$(node -e ${shellEscape(RESOLVE_BROKER_BINARY_SCRIPT)})"`,
      '&&',
      '"$BROKER" mcp-args --register',
      ...cliArgs,
    ].join(' ');
    // Suppress the broker's first-run telemetry notice. It's written to
    // stderr (src/telemetry.rs:373 eprintln!) but Daytona's executeCommand
    // merges streams, so the banner ends up mixed into the JSON stdout we
    // need to parse. AGENT_RELAY_TELEMETRY_DISABLED=1 short-circuits
    // TelemetryClient::new before the first-run block even evaluates.
    const env: Record<string, string> = {
      RELAY_API_KEY: opts.relayApiKey,
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
    };
    if (baseUrl) {
      env.RELAY_BASE_URL = baseUrl;
    }
    const result = await this.executeRuntimeCommand(handle, command, { cwd: opts.sandboxHome, env });

    if (result.exitCode !== 0) {
      // Fail loudly. Previous warn-and-continue behavior let agents spawn
      // without relaycast MCP and fail 20s-2min later with "relaycast not
      // available" — a single root-cause manifesting as N confusing
      // downstream failures. Better to abort the step now with the real
      // error so the underlying issue (credentials, SDK install, broker
      // binary missing) surfaces immediately.
      throw new Error(
        `[${opts.stepName}] mcp-args --register failed (exit ${result.exitCode}): ` +
          result.output.slice(-2000),
      );
    }

    // Defensive: extract the JSON object from the output. The broker writes
    // JSON to stdout but Daytona's executeCommand merges stderr. Future
    // warnings/notices on stderr would otherwise break the parse. The
    // broker's output format is a single top-level JSON object, so the
    // first '{' is where it starts; everything before is noise.
    const jsonStart = result.output.indexOf('{');
    if (jsonStart < 0) {
      throw new Error(
        `[${opts.stepName}] mcp-args --register returned no JSON object:\n` +
          result.output.slice(-2000),
      );
    }
    let parsed: { args?: unknown; sideEffectFiles?: unknown; agentToken?: unknown };
    try {
      parsed = JSON.parse(result.output.slice(jsonStart).trim());
    } catch (err) {
      throw new Error(
        `[${opts.stepName}] mcp-args --register returned unparseable output: ${this.formatError(err)}\n` +
          result.output.slice(-2000),
      );
    }
    return {
      args: Array.isArray(parsed.args) ? parsed.args.filter((arg): arg is string => typeof arg === 'string') : [],
      sideEffectFiles: Array.isArray(parsed.sideEffectFiles)
        ? parsed.sideEffectFiles.filter((file): file is string => typeof file === 'string')
        : [],
      agentToken: typeof parsed.agentToken === 'string' ? parsed.agentToken : null,
    };
  }

  private async mountCloudAuthFile(
    handle: RuntimeHandle,
    sandboxHome: string,
    env: Record<string, string>,
  ): Promise<void> {
    const apiUrl = env.CLOUD_API_URL?.trim();
    const accessToken = env.CLOUD_API_ACCESS_TOKEN?.trim();
    const refreshToken = env.CLOUD_API_REFRESH_TOKEN?.trim();
    const accessTokenExpiresAt = env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT?.trim();
    if (!apiUrl || !accessToken || !refreshToken || !accessTokenExpiresAt) {
      return;
    }
    const authDir = sandboxHome + '/.agentworkforce/relay';
    const payload = JSON.stringify({ apiUrl, accessToken, refreshToken, accessTokenExpiresAt }) + '\n';
    await this.executeRuntimeCommand(handle, "mkdir -p " + shellEscape(authDir), { cwd: sandboxHome });
    await this.runtime.uploadFile(handle, Buffer.from(payload), authDir + '/cloud-auth.json');
  }

  private async ensureCliInstalled(
    handle: RuntimeHandle,
    provider: keyof typeof CLI_AUTH_CONFIG
  ): Promise<void> {
    const config = CLI_AUTH_CONFIG[provider];
    if (!config?.installCommand) return;

    const check = await this.executeRuntimeCommand(
      handle,
      `command -v ${config.command} >/dev/null 2>&1 || (${config.installCommand})`
    );
    if (check.exitCode !== 0) {
      throw new Error(`Failed to install CLI "${config.command}": ${check.output}`);
    }
  }

  private async getRuntimeHome(handle: RuntimeHandle): Promise<string> {
    if (handle.homeDir) {
      return handle.homeDir;
    }

    return this.runtime.getHomeDir(handle);
  }

  private async disposeRuntime(handle: RuntimeHandle): Promise<void> {
    await retryAsync(
      () => this.sandboxOrchestrator.teardown(handle),
      [0, 1_000, 3_000],
      (err, attempt) => {
        console.warn(
          `[executor] sandbox teardown attempt ${attempt} failed for ${handle.id}: ${this.formatError(err)}`,
        );
      },
    );
  }

  private async executeRuntimeCommand(
    handle: RuntimeHandle,
    command: string,
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ output: string; exitCode: number }> {
    const result = await this.sandboxOrchestrator.runScript(handle, {
      command,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      output: result.output,
      exitCode: result.exitCode ?? 1,
    };
  }

  private resolveRelayfileTokenForAgent(agentName: string): string {
    const raw = this.envSecrets.RELAY_AGENT_TOKENS;
    if (!raw?.trim()) {
      return this.relayfileToken;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, RelayAgentTokenRecord>;
      const agentToken = parsed?.[agentName]?.token;
      if (typeof agentToken === 'string' && agentToken.trim()) {
        return agentToken.trim();
      }
    } catch {
      // Invalid token map — fall back to the bootstrap token.
    }

    return this.relayfileToken;
  }

  private formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private createCredentialMountTarget(handle: RuntimeHandle): Parameters<typeof mountCliCredentials>[0] {
    return {
      fs: {
        uploadFile: (file: string | Buffer, remotePath: string) => this.runtime.uploadFile(handle, file, remotePath),
      },
      process: {
        executeCommand: async (command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => {
          const result = await this.sandboxOrchestrator.runScript(handle, {
            command,
            cwd,
            env,
            timeoutMs: timeout === undefined ? undefined : timeout * 1000,
          });

          return {
            exitCode: result.exitCode ?? 1,
            result: result.output,
          };
        },
      },
    } as Parameters<typeof mountCliCredentials>[0];
  }
}

export { SandboxedStepExecutor as DaytonaStepExecutor };

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function joinRemotePath(root: string, relativePath: string): string {
  return `${stripTrailingSlash(root)}/${relativePath}`;
}

function remoteDirname(remotePath: string): string {
  const index = remotePath.lastIndexOf('/');
  if (index <= 0) {
    return '.';
  }
  return remotePath.slice(0, index);
}

function artifactTargetPath(root: string, stepName: string, relativePath: string): string {
  return joinRemotePath(
    root,
    `.agent-relay/step-artifacts/${sanitizeArtifactStepName(stepName)}/${relativePath}`,
  );
}

function shouldMirrorToStepArtifacts(stepName: string): boolean {
  return stepName === 'implement' || stepName.startsWith('implement-repair-');
}

function sanitizeArtifactStepName(stepName: string): string {
  const sanitized = stepName.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized || 'step';
}

function buildStepSandboxName(stepName: string, runId: string, sequence: number): string {
  const stepSlug = sanitizeSandboxNameSegment(stepName);
  const runSlug = sanitizeSandboxNameSegment(runId).slice(0, 8) || 'run';
  const suffix = `${runSlug}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  const maxStepLength = Math.max(1, 63 - suffix.length - 1);
  return `${stepSlug.slice(0, maxStepLength)}-${suffix}`;
}

function sanitizeSandboxNameSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return 'step';
  return /^[a-z]/.test(sanitized) ? sanitized : `s-${sanitized}`;
}

async function retryAsync<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
  onFailure?: (error: unknown, attempt: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < delaysMs.length; index += 1) {
    const delayMs = delaysMs[index] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      onFailure?.(err, index + 1);
    }
  }
  throw lastError;
}

function pathRelativeToCodeMount(root: string, remotePath: string): string {
  const prefix = `${stripTrailingSlash(root)}/`;
  return remotePath.startsWith(prefix) ? remotePath.slice(prefix.length) : remotePath;
}

function isSafeRelativeProjectPath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\0')) {
    return false;
  }

  return relativePath.split('/').every((segment) => {
    return Boolean(segment) && segment !== '.' && segment !== '..';
  });
}

function isIgnoredProjectArtifactPath(relativePath: string): boolean {
  const first = relativePath.split('/', 1)[0];
  return (
    first === '.agent-relay'
    || first === '.relay'
    || first === '.skills'
    || first === '.trajectories'
    || relativePath === '.relayfile.acl'
    || relativePath === '.relayfile-mount-state.json'
    || relativePath.startsWith('..relayfile-mount-state.json.tmp-')
  );
}
