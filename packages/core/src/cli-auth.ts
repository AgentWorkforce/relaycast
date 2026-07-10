/**
 * CLI Auth helpers for harness/provider authentication.
 *
 * Interactive provider auth is owned by the `agent-relay` CLI, which handles
 * browser login, creates the Daytona SSH session through the cloud API, and
 * stores the resulting credentials server-side. This helper delegates to that
 * CLI via `agent-relay cloud connect`.
 *
 * The volume-based helpers below remain for direct sandbox mounting flows.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Daytona } from "@daytonaio/sdk";
import { CLI_AUTH_CONFIG } from "@agent-relay/config/cli-auth-config";

// ── Constants ────────────────────────────────────────────────────────────────

export const CREDENTIAL_VOLUME_NAME = "cli-auth-credentials";
export const DEFAULT_SANDBOX_LANGUAGE = "typescript";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderId = keyof typeof CLI_AUTH_CONFIG;

type Sandbox = Awaited<ReturnType<Daytona["create"]>>;

export interface AuthOptions {
  /** Max time for the interactive session (seconds). Default: 300 */
  timeoutSeconds?: number;
  /** Sandbox language/image. Default: typescript */
  language?: string;
}

export interface AuthResult {
  provider: ProviderId;
  volumeName: string;
}

export interface CredentialMetadata {
  providers: Record<
    string,
    { authenticatedAt: string; credentialPath: string }
  >;
  lastUpdated: string;
}

type AgentRelayPackageJson = {
  bin?: string | Record<string, string>;
};

const require = createRequire(import.meta.url);

function resolveAgentRelayEntrypoint(): string {
  const packageJsonPath = require.resolve("agent-relay/package.json");
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8")
  ) as AgentRelayPackageJson;
  const binField = packageJson.bin;
  const relativeEntrypoint =
    typeof binField === "string" ? binField : binField?.["agent-relay"];

  if (!relativeEntrypoint) {
    throw new Error("Unable to resolve the agent-relay entrypoint");
  }

  return path.resolve(path.dirname(packageJsonPath), relativeEntrypoint);
}

// ── CliAuth class ────────────────────────────────────────────────────────────

export class CliAuth {
  private daytona: Daytona;

  constructor(daytona?: Daytona) {
    this.daytona = daytona ?? new Daytona();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Full interactive auth flow via the agent-relay CLI.
   *
   * Spawns `agent-relay cloud connect <provider>` with stdio inherited so the
   * user sees the interactive PTY session inline in their terminal. The relay
   * CLI owns browser login, sandbox creation, SSH, PTY handling, and credential
   * persistence.
   */
  async authenticate(
    provider: ProviderId,
    options?: AuthOptions
  ): Promise<AuthResult> {
    const config = CLI_AUTH_CONFIG[provider];
    if (!config) {
      throw new Error(
        `Unknown provider: ${provider}. Supported: ${Object.keys(CLI_AUTH_CONFIG).join(", ")}`
      );
    }

    const timeout = String(options?.timeoutSeconds ?? 300);
    const language = options?.language ?? "typescript";
    const cliEntrypoint = resolveAgentRelayEntrypoint();

    const args = [
      "cloud",
      "connect",
      provider,
      "--timeout",
      timeout,
      "--language",
      language,
    ];

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntrypoint, ...args], {
        stdio: "inherit",
        env: process.env,
      });

      child.on("exit", (code) => {
        resolve(code ?? 1);
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to run agent-relay cloud connect: ${err.message}`));
      });
    });

    if (exitCode !== 0) {
      throw new Error(`agent-relay cloud connect exited with code ${exitCode}`);
    }

    return {
      provider,
      volumeName: CREDENTIAL_VOLUME_NAME,
    };
  }

  /**
   * Retrieve stored credentials for a provider from the volume.
   * Spins up a short-lived sandbox to read from the mounted volume.
   */
  async getCredentials(provider: ProviderId): Promise<string | null> {
    const config = CLI_AUTH_CONFIG[provider];
    if (!config?.credentialPath) return null;

    let volume;
    try {
      volume = await this.daytona.volume.get(CREDENTIAL_VOLUME_NAME);
    } catch {
      return null; // volume doesn't exist yet
    }

    const reader = await this.daytona.create({
      language: DEFAULT_SANDBOX_LANGUAGE,
      autoStopInterval: 5,
      volumes: [{ volumeId: volume.id, mountPath: "/credentials" }],
    });

    try {
      const filename = path.basename(config.credentialPath);
      const buf = await reader.fs.downloadFile(
        `/credentials/${provider}/${filename}`
      );
      return buf.toString("utf-8");
    } catch {
      return null;
    } finally {
      await this.daytona.delete(reader).catch(() => {});
    }
  }

  /**
   * List all authenticated providers from the volume metadata.
   */
  async listAuthenticated(): Promise<CredentialMetadata | null> {
    let volume;
    try {
      volume = await this.daytona.volume.get(CREDENTIAL_VOLUME_NAME);
    } catch {
      return null;
    }

    const reader = await this.daytona.create({
      language: DEFAULT_SANDBOX_LANGUAGE,
      autoStopInterval: 5,
      volumes: [{ volumeId: volume.id, mountPath: "/credentials" }],
    });

    try {
      const buf = await reader.fs.downloadFile("/credentials/metadata.json");
      return JSON.parse(buf.toString("utf-8")) as CredentialMetadata;
    } catch {
      return null;
    } finally {
      await this.daytona.delete(reader).catch(() => {});
    }
  }

  /**
   * Mount credentials for a provider onto a target sandbox.
   *
   * If the credential volume is already mounted on the sandbox (at
   * `volumeMountPath`, default `/credentials`), creates symlinks from
   * the CLI's expected paths to the volume files. This means credential
   * refreshes on the volume are reflected immediately.
   *
   * If the volume is not mounted, falls back to copying credentials
   * from the volume via a temporary sandbox.
   */
  async mountToSandbox(
    sandbox: Sandbox,
    provider: ProviderId,
    home: string,
    volumeMountPath: string = "/credentials"
  ): Promise<boolean> {
    const config = CLI_AUTH_CONFIG[provider];
    if (!config?.credentialPath) return false;

    const filename = path.basename(config.credentialPath);
    const volumeCredPath = `${volumeMountPath}/${provider}/${filename}`;

    // Check if the credential volume is mounted and the file exists
    const volumeCheck = await sandbox.process.executeCommand(
      `test -f ${volumeCredPath} && echo EXISTS || echo MISSING`
    );
    const volumeMounted = volumeCheck.result.trim() === "EXISTS";

    if (volumeMounted) {
      // Symlink from CLI's expected path to the volume file
      return this.symlinkCredentials(sandbox, provider, home, volumeCredPath);
    }

    // Fallback: copy credentials from the volume via a temporary sandbox
    const credentials = await this.getCredentials(provider);
    if (!credentials) return false;
    return this.copyCredentials(sandbox, provider, home, credentials);
  }

  /**
   * Create symlinks from CLI-expected paths to the volume file.
   */
  private async symlinkCredentials(
    sandbox: Sandbox,
    provider: ProviderId,
    home: string,
    volumeCredPath: string
  ): Promise<boolean> {
    switch (provider) {
      case "anthropic": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.claude`);
        await sandbox.process.executeCommand(
          `ln -sf ${volumeCredPath} ${home}/.claude/.credentials.json`
        );
        // Onboarding config must be a real file (not on volume)
        const claudeConfig = JSON.stringify({
          hasCompletedOnboarding: true,
          firstStartTime: new Date().toISOString(),
        });
        await sandbox.fs.uploadFile(
          Buffer.from(claudeConfig),
          `${home}/.claude.json`
        );
        break;
      }
      case "openai": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.codex`);
        await sandbox.process.executeCommand(
          `ln -sf ${volumeCredPath} ${home}/.codex/auth.json`
        );
        break;
      }
      case "google": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.config/gemini`);
        await sandbox.process.executeCommand(
          `ln -sf ${volumeCredPath} ${home}/.config/gemini/credentials.json`
        );
        break;
      }
      default: {
        const config = CLI_AUTH_CONFIG[provider];
        if (!config?.credentialPath) return false;
        const targetPath = `${home}/${config.credentialPath.replace("~/", "")}`;
        await sandbox.process.executeCommand(`mkdir -p $(dirname ${targetPath})`);
        await sandbox.process.executeCommand(
          `ln -sf ${volumeCredPath} ${targetPath}`
        );
        break;
      }
    }
    return true;
  }

  /**
   * Copy credentials directly to the sandbox (fallback when volume not mounted).
   */
  private async copyCredentials(
    sandbox: Sandbox,
    provider: ProviderId,
    home: string,
    credentials: string
  ): Promise<boolean> {
    switch (provider) {
      case "anthropic": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.claude`);
        await sandbox.fs.uploadFile(
          Buffer.from(credentials),
          `${home}/.claude/.credentials.json`
        );
        const claudeConfig = JSON.stringify({
          hasCompletedOnboarding: true,
          firstStartTime: new Date().toISOString(),
        });
        await sandbox.fs.uploadFile(
          Buffer.from(claudeConfig),
          `${home}/.claude.json`
        );
        break;
      }
      case "openai": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.codex`);
        await sandbox.fs.uploadFile(
          Buffer.from(credentials),
          `${home}/.codex/auth.json`
        );
        break;
      }
      case "google": {
        await sandbox.process.executeCommand(`mkdir -p ${home}/.config/gemini`);
        await sandbox.fs.uploadFile(
          Buffer.from(credentials),
          `${home}/.config/gemini/credentials.json`
        );
        break;
      }
      default: {
        const config = CLI_AUTH_CONFIG[provider];
        if (!config?.credentialPath) return false;
        const targetPath = `${home}/${config.credentialPath.replace("~/", "")}`;
        await sandbox.process.executeCommand(`mkdir -p $(dirname ${targetPath})`);
        await sandbox.fs.uploadFile(Buffer.from(credentials), targetPath);
        break;
      }
    }
    return true;
  }
}
