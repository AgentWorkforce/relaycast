import { optionalEnv, tryResourceValue } from "@/lib/env";

const HOUSE_KEY_ENV: Record<string, string> = {
  anthropic: "HOUSE_ANTHROPIC_KEY",
  openai: "HOUSE_OPENAI_KEY",
  google: "HOUSE_GOOGLE_KEY",
  openrouter: "HOUSE_OPENROUTER_KEY",
  opencode: "HOUSE_OPENROUTER_KEY",
};

const HOUSE_KEY_RESOURCE: Record<string, string> = {
  anthropic: "HouseAnthropicKey",
  openai: "HouseOpenaiKey",
  google: "HouseGoogleKey",
  openrouter: "HouseOpenrouterKey",
  opencode: "HouseOpenrouterKey",
};

export function normalizeModelProvider(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "openai" || normalized === "codex") {
    return "openai";
  }
  if (normalized === "google" || normalized === "gemini") {
    return "google";
  }
  if (normalized === "openrouter") {
    return "openrouter";
  }
  if (normalized === "opencode") {
    return "opencode";
  }
  if (normalized === "xai" || normalized === "grok") {
    return "xai";
  }
  if (normalized === "daytona") {
    return "daytona";
  }
  return null;
}

export function harnessForModelProvider(modelProvider: string): string {
  switch (modelProvider) {
    case "anthropic":
      return "claude";
    case "openai":
      return "codex";
    case "google":
      return "gemini";
    case "openrouter":
      return "openrouter";
    case "opencode":
      return "opencode";
    case "xai":
      return "grok";
    case "daytona":
      return "daytona";
    default:
      return modelProvider;
  }
}

export function displayNameForModelProvider(modelProvider: string): string {
  switch (modelProvider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "openrouter":
      return "OpenRouter";
    case "opencode":
      return "OpenCode";
    case "xai":
      return "xAI";
    case "daytona":
      return "Daytona";
    default:
      return modelProvider.charAt(0).toUpperCase() + modelProvider.slice(1);
  }
}

export function resolveHouseKey(modelProvider: string): string | undefined {
  const normalized = normalizeModelProvider(modelProvider);
  if (!normalized) {
    return undefined;
  }

  const resourceValue = tryResourceValue(HOUSE_KEY_RESOURCE[normalized])?.trim();
  if (resourceValue) {
    return resourceValue;
  }

  return optionalEnv(HOUSE_KEY_ENV[normalized])?.trim();
}
