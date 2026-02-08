import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

export interface OpenClawConfig {
  agent?: {
    model?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenClawDetection {
  /** Whether OpenClaw appears to be installed. */
  installed: boolean;
  /** Path to the openclaw config directory. */
  configDir: string;
  /** Path to openclaw.json if it exists. */
  configFile: string | null;
  /** Path to the workspace directory. */
  workspaceDir: string;
  /** Parsed config if available. */
  config: OpenClawConfig | null;
}

/** Default OpenClaw config directory. */
function openclawHome(): string {
  return join(homedir(), '.openclaw');
}

/**
 * Detect whether OpenClaw is installed and return paths/config.
 */
export async function detectOpenClaw(): Promise<OpenClawDetection> {
  const configDir = openclawHome();
  const configPath = join(configDir, 'openclaw.json');
  const workspaceDir = join(configDir, 'workspace');

  const installed = existsSync(configDir);
  let config: OpenClawConfig | null = null;
  let configFile: string | null = null;

  if (existsSync(configPath)) {
    configFile = configPath;
    try {
      const raw = await readFile(configPath, 'utf-8');
      config = JSON.parse(raw) as OpenClawConfig;
    } catch {
      // Config exists but isn't valid JSON — that's fine
    }
  }

  return {
    installed,
    configDir,
    configFile,
    workspaceDir,
    config,
  };
}

/**
 * Load and parse ~/.openclaw/openclaw.json.
 * Returns null if not found or unparseable.
 */
export async function loadOpenClawConfig(): Promise<OpenClawConfig | null> {
  const detection = await detectOpenClaw();
  return detection.config;
}
