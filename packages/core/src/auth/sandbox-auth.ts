/**
 * Sandbox Auth — Server-side sandbox lifecycle for CLI auth sessions.
 *
 * Creates a Daytona sandbox for interactive CLI login, provides SSH access,
 * and on completion encrypts credentials and stores them in S3 keyed by
 * userId. Used by the CLI auth API routes so the CLI only needs SSH
 * connection info, not a Daytona API key.
 */

import crypto from "node:crypto";
import { Daytona } from "@daytonaio/sdk";
import { CLI_AUTH_CONFIG } from "@agent-relay/config/cli-auth-config";
import {
  resolveDaytonaAuthCredentials,
  type ResolvedDaytonaAuthCredentials,
} from "./credentials.js";
import {
  createCredentialStore,
  type DaytonaCredential,
} from "./credential-store.js";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SANDBOX_LANGUAGE = "typescript";
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ────────────────────────────────────────────────────────────────────

type Sandbox = Awaited<ReturnType<Daytona["create"]>>;

export interface SessionData {
  sessionId: string;
  sandboxId: string;
  sshToken: string;
  provider: string;
  language: string;
  home: string;
  userId: string;
  daytonaAuth: ResolvedDaytonaAuthCredentials;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionStore {
  create(session: SessionData): Promise<void>;
  get(sessionId: string): Promise<SessionData | null>;
  delete(sessionId: string): Promise<void>;
}

export interface CreateAuthSandboxOptions {
  provider: string;
  userId: string;
  daytonaApiKey?: string;
  daytonaJwtToken?: string;
  daytonaOrganizationId?: string;
  language?: string;
  sessionStore: SessionStore;
}

export interface CreateAuthSandboxResult {
  sessionId: string;
  ssh: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  remoteCommand: string;
  provider: string;
  expiresAt: string;
}

export interface CompleteAuthSessionOptions {
  sessionId: string;
  success: boolean;
  credentialEncryptionKey: string;
  sessionStore: SessionStore;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return `auth-${crypto.randomUUID()}`;
}

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_/\\.=:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseSshCommand(sshCommand: string): {
  host: string;
  port: number;
  user: string;
} {
  const userHostMatch = sshCommand.match(/(\S+)@(\S+)\s*$/);
  if (!userHostMatch) {
    throw new Error(`Could not parse SSH command: ${sshCommand}`);
  }
  const portMatch = sshCommand.match(/-p\s+(\d+)/);
  return {
    host: userHostMatch[2],
    port: portMatch ? parseInt(portMatch[1], 10) : 22,
    user: userHostMatch[1],
  };
}

async function cleanupSandbox(
  daytona: Daytona,
  sandbox: Sandbox,
  sshToken: string,
): Promise<void> {
  try {
    await sandbox.revokeSshAccess(sshToken);
  } catch {
    // best-effort
  }
  try {
    await daytona.delete(sandbox);
  } catch {
    // best-effort — sandbox auto-stops after 15min regardless
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildRemoteAuthCommandOptions {
  provider: string;
  providerConfig: {
    command: string;
    args: readonly string[];
    /** Args for the provider's headless/device-code login flow, if it has one. */
    deviceFlowArgs?: readonly string[];
    /** Whether the provider CLI supports a device-code (no-callback) login. */
    supportsDeviceFlow?: boolean;
    installCommand?: string;
    env?: Record<string, string>;
  };
  home: string;
}

interface DaytonaConfigToken {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
}

interface DaytonaConfigProfile {
  id?: unknown;
  api?: { token?: DaytonaConfigToken | null } | null;
  activeOrganizationId?: unknown;
}

interface DaytonaConfigFile {
  activeProfile?: unknown;
  profiles?: unknown;
}

function extractDaytonaCredential(credentials: string): DaytonaCredential {
  let parsed: DaytonaConfigFile;
  try {
    parsed = JSON.parse(credentials) as DaytonaConfigFile;
  } catch {
    throw new Error("Daytona credential file is not valid JSON");
  }

  if (!Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
    throw new Error("Daytona credential file has no profiles");
  }

  const profiles = parsed.profiles as DaytonaConfigProfile[];
  const activeProfileId =
    typeof parsed.activeProfile === "string" && parsed.activeProfile.length > 0
      ? parsed.activeProfile
      : null;
  const profile =
    (activeProfileId
      ? profiles.find((candidate) => candidate.id === activeProfileId)
      : undefined) ?? profiles[0];
  const token = profile.api?.token;

  if (
    !token ||
    typeof token.accessToken !== "string" ||
    typeof token.refreshToken !== "string" ||
    typeof token.expiresAt !== "string" ||
    token.accessToken.length === 0 ||
    token.refreshToken.length === 0 ||
    token.expiresAt.length === 0
  ) {
    throw new Error("Daytona active profile is missing token fields");
  }

  return {
    provider: "daytona",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    ...(typeof profile.activeOrganizationId === "string" &&
    profile.activeOrganizationId.length > 0
      ? { orgId: profile.activeOrganizationId }
      : {}),
  };
}

export function normalizeStoredCredentialForProvider(
  provider: string,
  credentials: string,
): string {
  if (provider === "daytona") {
    return JSON.stringify(extractDaytonaCredential(credentials));
  }

  JSON.parse(credentials);
  return credentials;
}

function providerEnvExports(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) {
    return "";
  }

  return Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid provider auth env var name: ${key}`);
      }
      return `export ${key}=${shellEscape(value)}`;
    })
    .join("; ");
}

export function buildRemoteAuthCommand(
  options: BuildRemoteAuthCommandOptions
): string {
  const { provider, providerConfig, home } = options;

  // The auth sandbox is reached over Daytona's managed SSH gateway
  // (ssh.app.daytona.io), which does NOT forward TCP (direct-tcpip) into the
  // sandbox. codex's default `codex login` starts a loopback OAuth callback
  // server on the sandbox's 127.0.0.1:1455 and waits for the browser redirect
  // to reach it over an SSH port-forward — but that forward dies at the
  // gateway, so the callback never lands and login times out. codex's
  // device-code flow (`codex login --device-auth`) needs no inbound callback:
  // it prints a URL + one-time code, the user enters the code in their
  // browser, and codex polls OpenAI over outbound HTTPS from inside the
  // sandbox. The interactive SSH PTY (which works fine; only forwarding is
  // broken) carries the prompts. Prefer the device flow when the provider
  // supports it. grok has the same loopback-callback default and the same
  // `--device-auth` escape hatch, so it joins codex on the device flow.
  const loginArgs =
    (providerConfig.command === "codex" || providerConfig.command === "grok") &&
    providerConfig.supportsDeviceFlow &&
    providerConfig.deviceFlowArgs
      ? providerConfig.deviceFlowArgs
      : providerConfig.args;

  const primaryCmd = [providerConfig.command, ...loginArgs]
    .map(shellEscape)
    .join(" ");
  const fallbackCmd =
    provider === "cursor"
      ? `command -v agent >/dev/null 2>&1 && ${primaryCmd} || cursor-agent ${loginArgs.map(shellEscape).join(" ")}`
      : primaryCmd;

  const exportPath = `export PATH=${home}/.local/bin:/home/workspace/.local/bin:$PATH`;
  const envExports = [exportPath, providerEnvExports(providerConfig.env)]
    .filter(Boolean)
    .join("; ");

  // The provider CLI version is governed by the Daytona snapshot, not by a
  // runtime install. The snapshot bakes codex (and the others) into a
  // root-owned global node_modules under nvm, so a runtime `npm install -g`
  // can neither override it (rename into the prefix → EACCES for the sandbox
  // user) nor even run — the `command -v` guard below short-circuits the
  // install whenever the CLI is already present, which it always is for codex.
  // To change the codex version, roll the snapshot. The guarded install stays
  // only as a genuine fallback for images that lack the CLI entirely.
  const installCommand = providerConfig.installCommand;

  if (installCommand) {
    return `${envExports}; command -v ${providerConfig.command} >/dev/null 2>&1 || ${installCommand}; exec ${fallbackCmd}`;
  }
  return `${envExports}; exec ${fallbackCmd}`;
}

/**
 * Create a sandbox for interactive CLI auth and return SSH connection info.
 */
export async function createAuthSandbox(
  options: CreateAuthSandboxOptions
): Promise<CreateAuthSandboxResult> {
  const {
    provider,
    userId,
    language = DEFAULT_SANDBOX_LANGUAGE,
    sessionStore,
  } = options;

  const providerConfig = (CLI_AUTH_CONFIG as Record<string, any>)[provider];
  if (!providerConfig) {
    throw new Error(
      `Unknown provider: ${provider}. Supported: ${Object.keys(CLI_AUTH_CONFIG).join(", ")}`
    );
  }

  const daytonaAuth = resolveDaytonaAuthCredentials({
    apiKey: options.daytonaApiKey,
    jwtToken: options.daytonaJwtToken,
    organizationId: options.daytonaOrganizationId,
  });
  const daytona = new Daytona(daytonaAuth);

  // Create sandbox for interactive CLI auth session
  const sandbox = await daytona.create({
    language,
    autoStopInterval: 15,
  });

  const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";

  // Get SSH access
  const sshAccess = await sandbox.createSshAccess(15);
  const { host, port, user } = parseSshCommand(sshAccess.sshCommand);

  // Build remote command (same logic as the original connect-daytona.ts)
  const remoteCommand = buildRemoteAuthCommand({
    provider,
    providerConfig,
    home,
  });

  const sessionId = generateSessionId();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);

  try {
    await sessionStore.create({
      sessionId,
      sandboxId: sandbox.id,
      sshToken: sshAccess.token,
      provider,
      language,
      home,
      userId,
      daytonaAuth,
      createdAt,
      expiresAt,
    });
  } catch (error) {
    await cleanupSandbox(daytona, sandbox, sshAccess.token);
    throw error;
  }

  return {
    sessionId,
    ssh: { host, port, user, password: sshAccess.token },
    remoteCommand,
    provider,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Complete an auth session — encrypt credentials and write to S3, cleanup sandbox.
 */
export async function completeAuthSession(
  options: CompleteAuthSessionOptions
): Promise<{ success: boolean; provider: string; credentialJson?: string }> {
  const { sessionId, success, credentialEncryptionKey, sessionStore } = options;

  const session = await sessionStore.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const daytona = new Daytona(session.daytonaAuth);
  let sandbox: Sandbox | null = null;

  try {
    sandbox = await daytona.get(session.sandboxId);
  } catch {
    await sessionStore.delete(sessionId);
    throw new Error(`Sandbox not found: ${session.sandboxId}`);
  }

  const { provider, home, userId } = session;

  try {
    if (session.expiresAt.getTime() <= Date.now()) {
      await cleanupSandbox(daytona, sandbox, session.sshToken);
      throw new Error(`Session expired: ${sessionId}`);
    }

    if (success) {
      const providerConfig = (CLI_AUTH_CONFIG as Record<string, any>)[provider];
      if (providerConfig?.credentialPath) {
        const credPath = `${home}/${providerConfig.credentialPath.replace("~/", "")}`;

        try {
          const credBuf = await sandbox.fs.downloadFile(credPath);
          const credentials = normalizeStoredCredentialForProvider(
            provider,
            credBuf.toString("utf-8"),
          );

          // Encrypt and store in S3 keyed by userId
          const store = createCredentialStore(credentialEncryptionKey);
          await store.store(userId, provider, credentials);
        } catch (err) {
          console.warn(
            `Warning: Could not store credentials for ${provider}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    await cleanupSandbox(daytona, sandbox, session.sshToken);
  } finally {
    await sessionStore.delete(sessionId);
  }

  return { success, provider };
}
