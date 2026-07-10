import { parseCredentialExpiry } from "@cloud/core/auth/credential-expiry.js";
import {
  refreshCredential,
  type RefreshableCredentialProvider,
} from "@cloud/core/auth/credential-refresher.js";

/**
 * Per-run expiry check + refresh + persist for harness CLI credentials.
 *
 * Why this exists: `mountHarnessCliCredential` used to mount the stored
 * auth.json verbatim — no expiry check, no refresh, no writeback. Freshness
 * rode entirely on the 6-hourly credential sweep cron
 * (`infra/credential-refresh.ts`), so a credential could be mounted up to
 * ~6h stale, and a DEAD refresh token (e.g. `codex login` on another
 * machine rotating it) silently 401'd every harness run with
 * "Bearer token is invalid" until an operator reconnected the provider.
 * This module makes the staleness window per-run and the dead-token case
 * loud.
 *
 * Conservative by design:
 *   - unknown expiry → mount as-is (never block a run on a parse gap);
 *   - unsupported provider → mount as-is (the refresher speaks
 *     the shared refreshable provider set);
 *   - refresh failure → re-retrieve once (a concurrent fire may have won a
 *     single-use refresh-token race and persisted a fresher blob);
 *   - refresh failure on a credential that is merely NEAR expiry → mount the
 *     stored credential with a LOUD structured warning (the run may still
 *     finish before the cliff);
 *   - refresh failure on a credential that is ALREADY expired → throw
 *     {@link HarnessCredentialExpiredError}. Mounting a provably dead token
 *     guarantees a cryptic harness-side 401 ("Bearer token is invalid");
 *     failing fast lets the delivery surface a user-actionable message on
 *     the run's FAILED card instead.
 */

/** Refresh when the credential expires within this window (or already has).
 *  Must cover sandbox boot + the LONGEST harness run, so a token mounted
 *  just outside the window cannot die mid-run: runs default to 30 minutes
 *  (`DEFAULT_RUN_SCRIPT_MAX_SECONDS`) and pr-reviewer configures 40
 *  (`harnessSettings.timeoutSeconds: 2400`); 45 minutes covers both plus
 *  boot. Provider access tokens live for hours, so the wider window still
 *  no-ops for healthy credentials, and an unnecessary refresh is cheap
 *  (persisted for the next run + the sweep). */
export const HARNESS_CREDENTIAL_REFRESH_SKEW_MS = 45 * 60 * 1000;

/** Providers `refreshCredential` can actually refresh. */
const REFRESHABLE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "xai",
  "daytona",
] as const);

type RefreshableProvider = RefreshableCredentialProvider;

const PROVIDER_LABELS: Record<RefreshableProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (Codex)",
  xai: "xAI (Grok)",
  daytona: "Daytona",
};

/** Thrown when the stored credential is already expired and refresh failed —
 *  the run cannot authenticate, and the user has to reconnect the provider.
 *  `userMessage` is written for the run's FAILED card, not for logs. */
export class HarnessCredentialExpiredError extends Error {
  readonly provider: string;
  readonly userMessage: string;

  constructor(provider: RefreshableProvider, expiresAt: Date) {
    const label = PROVIDER_LABELS[provider];
    const userMessage =
      `Your ${label} credentials have expired and could not be refreshed automatically. ` +
      `Reconnect ${label} in workspace settings (or run \`agentworkforce connect ${provider}\` ` +
      `and redeploy), then re-trigger this run.`;
    super(
      `harness credential for ${provider} expired at ${expiresAt.toISOString()} and refresh failed`,
    );
    this.name = "HarnessCredentialExpiredError";
    this.provider = provider;
    this.userMessage = userMessage;
  }
}

interface HarnessCredentialStore {
  retrieve(userId: string, provider: string): Promise<string | null>;
  store(userId: string, provider: string, credentialJson: string): Promise<void>;
}

type RefreshFn = (
  provider: RefreshableProvider,
  credentialJson: string,
) => Promise<{ credentialJson: string; expiresAt?: Date | null }>;

function isRefreshableProvider(provider: string): provider is RefreshableProvider {
  return (REFRESHABLE_PROVIDERS as Set<string>).has(provider);
}

function freshEnough(expiresAt: Date | null): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() - Date.now() > HARNESS_CREDENTIAL_REFRESH_SKEW_MS
  );
}

export async function refreshHarnessCliCredentialIfStale(input: {
  store: HarnessCredentialStore;
  userId: string;
  provider: string;
  credentialJson: string;
  /** Injectable for tests; defaults to the shared sweep refresher. */
  refresh?: RefreshFn;
}): Promise<string> {
  const { store, userId, provider, credentialJson } = input;
  if (!isRefreshableProvider(provider)) {
    return credentialJson;
  }
  const expiresAt = parseCredentialExpiry(credentialJson);
  if (expiresAt === null || freshEnough(expiresAt)) {
    return credentialJson;
  }

  const refresh = input.refresh ?? refreshCredential;
  try {
    const refreshed = await refresh(provider, credentialJson);
    await store.store(userId, provider, refreshed.credentialJson);
    console.info("[persona-bundle-deploy] harness credential refreshed before mount", {
      provider,
      userId,
      previousExpiresAt: expiresAt.toISOString(),
      expiresAt:
        refreshed.expiresAt?.toISOString() ??
        parseCredentialExpiry(refreshed.credentialJson)?.toISOString() ??
        null,
    });
    return refreshed.credentialJson;
  } catch (error) {
    // Concurrent-fire rescue: provider refresh tokens can be single-use, so
    // a parallel delivery may have refreshed first and rotated ours dead.
    // If a fresher blob is already persisted, use it.
    const latest = await store.retrieve(userId, provider).catch(() => null);
    if (latest && latest !== credentialJson && freshEnough(parseCredentialExpiry(latest))) {
      console.info(
        "[persona-bundle-deploy] harness credential refresh lost a concurrent race; using newer stored credential",
        { provider, userId },
      );
      return latest;
    }
    console.warn(
      "[persona-bundle-deploy] harness credential refresh FAILED",
      {
        provider,
        userId,
        expiresAt: expiresAt.toISOString(),
        expired: expiresAt.getTime() <= Date.now(),
        error: error instanceof Error ? error.message : String(error),
      },
    );
    if (expiresAt.getTime() <= Date.now()) {
      // Provably dead: mounting it guarantees a cryptic 401 — fail fast with
      // a message the run's FAILED card can show the user.
      throw new HarnessCredentialExpiredError(provider, expiresAt);
    }
    // Near-expiry but not past it: the run may still finish before the
    // cliff; mount as-is rather than failing a run that could succeed.
    return credentialJson;
  }
}
