export type AccountUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
  windowMinutes: number | null;
};

export type AccountUsageCredits = {
  balance: number | null;
  unlimited: boolean;
};

export type AccountUsageSnapshot = {
  provider: "anthropic" | "openai" | string;
  status: "available" | "unsupported" | "unavailable" | "error";
  source: "claude-oauth" | "codex-oauth" | "none";
  fetchedAt: string;
  windows: AccountUsageWindow[];
  credits?: AccountUsageCredits;
  plan?: string | null;
  error?: string;
};

export type AccountUsageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type FetchAccountUsageInput = {
  provider: string;
  credentialJson: string | null;
  fetch?: AccountUsageFetch;
  now?: Date;
};

type CodexCredential = {
  accessToken: string;
  accountId: string | null;
  idToken: string | null;
};

type ClaudeCredential = {
  accessToken: string;
};

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA_HEADER = "oauth-2025-04-20";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "===".slice((payload.length + 3) & 3);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as unknown;
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = numberValue(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromDateLike(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function usageWindow(input: {
  id: string;
  label: string;
  usedPercent: number | null;
  resetAt: string | null;
  windowMinutes?: number | null;
}): AccountUsageWindow | null {
  if (input.usedPercent === null) {
    return null;
  }
  const usedPercent = clampPercent(input.usedPercent);
  return {
    id: input.id,
    label: input.label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetAt: input.resetAt,
    windowMinutes: input.windowMinutes ?? null,
  };
}

function parseCodexWindow(id: string, label: string, raw: unknown): AccountUsageWindow | null {
  if (!isRecord(raw)) return null;
  const seconds = numberValue(raw.limit_window_seconds);
  return usageWindow({
    id,
    label,
    usedPercent: numberValue(raw.used_percent),
    resetAt: isoFromEpochSeconds(raw.reset_at),
    windowMinutes: seconds === null ? null : Math.round(seconds / 60),
  });
}

function parseClaudeWindow(id: string, label: string, raw: unknown): AccountUsageWindow | null {
  if (!isRecord(raw)) return null;
  return usageWindow({
    id,
    label,
    usedPercent: numberValue(raw.utilization),
    resetAt: isoFromDateLike(raw.resets_at),
  });
}

export function extractCodexUsageCredential(credentialJson: string): CodexCredential | null {
  const parsed = parseJsonObject(credentialJson);
  if (!parsed) return null;
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : parsed;
  const accessToken = stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  if (!accessToken) return null;
  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const tokenClaims = decodeJwtPayload(idToken);
  const authClaims = isRecord(tokenClaims?.["https://api.openai.com/auth"])
    ? (tokenClaims?.["https://api.openai.com/auth"] as Record<string, unknown>)
    : null;

  return {
    accessToken,
    accountId: stringValue(parsed.account_id)
      ?? stringValue(parsed.accountId)
      ?? stringValue(tokens.account_id)
      ?? stringValue(tokens.accountId)
      ?? stringValue(authClaims?.chatgpt_account_id)
      ?? stringValue(tokenClaims?.chatgpt_account_id),
    idToken,
  };
}

export function extractClaudeUsageCredential(credentialJson: string): ClaudeCredential | null {
  const parsed = parseJsonObject(credentialJson);
  if (!parsed) return null;

  const claudeOauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  const subscriptionToken = stringValue(claudeOauth?.accessToken);
  if (subscriptionToken) {
    return { accessToken: subscriptionToken };
  }

  if (parsed.type === "oauth_token") {
    const setupToken = stringValue(parsed.token);
    if (setupToken) {
      return { accessToken: setupToken };
    }
  }

  return null;
}

export function codexUsageSnapshotFromResponse(
  payload: unknown,
  credential: Pick<CodexCredential, "idToken">,
  now = new Date(),
): AccountUsageSnapshot {
  const record = isRecord(payload) ? payload : {};
  const rateLimit = isRecord(record.rate_limit) ? record.rate_limit : {};
  const windows = [
    parseCodexWindow("session", "Session", rateLimit.primary_window),
    parseCodexWindow("weekly", "Weekly", rateLimit.secondary_window),
  ].filter((window): window is AccountUsageWindow => window !== null);

  if (Array.isArray(record.additional_rate_limits)) {
    for (const entry of record.additional_rate_limits) {
      if (!isRecord(entry)) continue;
      const label = stringValue(entry.limit_name) ?? stringValue(entry.metered_feature) ?? "Additional";
      const extraRateLimit = isRecord(entry.rate_limit) ? entry.rate_limit : {};
      const primary = parseCodexWindow(`extra:${label}:session`, label, extraRateLimit.primary_window);
      if (primary) windows.push(primary);
      const weekly = parseCodexWindow(`extra:${label}:weekly`, `${label} weekly`, extraRateLimit.secondary_window);
      if (weekly) windows.push(weekly);
    }
  }

  const credits = isRecord(record.credits)
    ? {
        balance: numberValue(record.credits.balance),
        unlimited: record.credits.unlimited === true,
      }
    : undefined;
  const tokenClaims = decodeJwtPayload(credential.idToken);
  const authClaims = isRecord(tokenClaims?.["https://api.openai.com/auth"])
    ? (tokenClaims?.["https://api.openai.com/auth"] as Record<string, unknown>)
    : null;
  const plan = stringValue(record.plan_type) ?? stringValue(authClaims?.chatgpt_plan_type);

  return {
    provider: "openai",
    status: windows.length > 0 || credits ? "available" : "unavailable",
    source: "codex-oauth",
    fetchedAt: now.toISOString(),
    windows,
    ...(credits ? { credits } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function claudeUsageSnapshotFromResponse(payload: unknown, now = new Date()): AccountUsageSnapshot {
  const record = isRecord(payload) ? payload : {};
  const windows = [
    parseClaudeWindow("session", "Session", record.five_hour),
    parseClaudeWindow("weekly", "Weekly", record.seven_day),
    parseClaudeWindow("sonnet-weekly", "Sonnet weekly", record.seven_day_sonnet),
    parseClaudeWindow("opus-weekly", "Opus weekly", record.seven_day_opus),
    parseClaudeWindow("routines-weekly", "Routines weekly", record.seven_day_routines ?? record.routines),
  ].filter((window): window is AccountUsageWindow => window !== null);

  const extraUsage = isRecord(record.extra_usage) ? record.extra_usage : null;
  const monthlyLimit = extraUsage ? numberValue(extraUsage.monthly_limit) : null;
  const usedCredits = extraUsage ? numberValue(extraUsage.used_credits) : null;
  const credits = extraUsage
    ? {
        balance: monthlyLimit === null || usedCredits === null
          ? null
          : Math.max(0, monthlyLimit - usedCredits),
        unlimited: false,
      }
    : undefined;

  return {
    provider: "anthropic",
    status: windows.length > 0 || credits ? "available" : "unavailable",
    source: "claude-oauth",
    fetchedAt: now.toISOString(),
    windows,
    ...(credits ? { credits } : {}),
  };
}

async function fetchJson(
  fetchImpl: AccountUsageFetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype\s+html/i.test(text) || /^\s*<html/i.test(text);
    const detail = text.length > 0 && !isHtml ? `: ${text.slice(0, 300)}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
  return text ? JSON.parse(text) as unknown : {};
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

export async function fetchAccountUsageSnapshot(
  input: FetchAccountUsageInput,
): Promise<AccountUsageSnapshot> {
  const now = input.now ?? new Date();
  const fetchedAt = now.toISOString();
  const provider = input.provider;

  if (provider !== "openai" && provider !== "anthropic") {
    return {
      provider,
      status: "unsupported",
      source: "none",
      fetchedAt,
      windows: [],
      error: "Usage snapshots are only supported for Codex and Claude credentials.",
    };
  }

  if (!input.credentialJson) {
    return {
      provider,
      status: "unavailable",
      source: "none",
      fetchedAt,
      windows: [],
      error: "Credential material is unavailable.",
    };
  }

  const fetchImpl = input.fetch ?? fetch;
  const signal = timeoutSignal(10_000);

  try {
    if (provider === "openai") {
      const credential = extractCodexUsageCredential(input.credentialJson);
      if (!credential) {
        return {
          provider,
          status: "unavailable",
          source: "none",
          fetchedAt,
          windows: [],
          error: "Stored Codex credential does not include an OAuth access token.",
        };
      }
      if (!credential.accountId) {
        return {
          provider,
          status: "unavailable",
          source: "none",
          fetchedAt,
          windows: [],
          error: "Stored Codex credential does not include an account id.",
        };
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${credential.accessToken}`,
        accept: "application/json",
        "user-agent": "CodexBar",
        "chatgpt-account-id": credential.accountId,
      };
      const payload = await fetchJson(fetchImpl, CODEX_USAGE_URL, { headers, signal });
      return codexUsageSnapshotFromResponse(payload, credential, now);
    }

    const credential = extractClaudeUsageCredential(input.credentialJson);
    if (!credential) {
      return {
        provider,
        status: "unavailable",
        source: "none",
        fetchedAt,
        windows: [],
        error: "Stored Claude credential does not include an OAuth access token.",
      };
    }
    const payload = await fetchJson(fetchImpl, CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-beta": CLAUDE_BETA_HEADER,
        "user-agent": "claude-code/2.1.0",
      },
      signal,
    });
    return claudeUsageSnapshotFromResponse(payload, now);
  } catch (error) {
    return {
      provider,
      status: "error",
      source: provider === "openai" ? "codex-oauth" : "claude-oauth",
      fetchedAt,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
