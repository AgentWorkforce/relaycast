import os from "node:os";
import path from "node:path";

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "cursor",
  "opencode",
  "droid",
] as const;

export const REFRESH_WINDOW_MS = 60_000;
export const AUTH_FILE_PATH = path.join(os.homedir(), ".agentworkforce", "relay", "cloud-auth.json");
const DEFAULT_CLOUD_API_URL = "https://agentrelay.com/cloud";

export function defaultApiUrl(): string {
  return process.env.CLOUD_API_URL?.trim() || DEFAULT_CLOUD_API_URL;
}

export function isSupportedProvider(provider: string): boolean {
  return SUPPORTED_PROVIDERS.includes(provider as (typeof SUPPORTED_PROVIDERS)[number]);
}
