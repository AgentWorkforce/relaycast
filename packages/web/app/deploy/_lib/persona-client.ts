import { toAppPath } from "@/lib/app-path";
import { cardImageFromPersonaUrl, demoPersonaForUrl } from "./demo-personas";
import type {
  DeployMode,
  PersonaResolveError,
  PersonaSummary,
  ResolvedPersona,
} from "./types";

/**
 * Resolve the persona referenced by the `?persona=` GitHub blob URL into a
 * UI-friendly summary (+ compiled bundle in live mode).
 *
 * Phase 1 (demo mode): return baked-in demo data immediately.
 * Phase 2 (live mode): call `POST /api/persona/resolve`, which fetches the
 * raw `persona.ts` from GitHub, compiles it, and returns the spec + bundle. If
 * that call fails we degrade to the demo summary so the wizard still renders.
 */
export async function resolvePersona(
  url: string | null,
  mode: DeployMode,
): Promise<ResolvedPersona> {
  if (mode === "demo") {
    return { summary: demoPersonaForUrl(url), demo: true };
  }

  try {
    const res = await fetch(toAppPath("/api/persona/resolve"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const message = await resolveErrorMessage(res);
      // 401/403 are *blocking* auth/access failures, not parse fallbacks: the
      // real (private) persona could not be read at all. Surface them as a
      // structured `resolveError` so the wizard can show an actionable banner
      // and refuse to deploy demo data in place of the real persona. Everything
      // else (parse/compile/network) degrades softly via the catch below.
      const resolveError = resolveBlockingError(res.status, message);
      if (resolveError) {
        return {
          summary: demoPersonaForUrl(url),
          demo: true,
          fallbackReason: message,
          resolveError,
        };
      }
      throw new Error(message);
    }
    const payload = (await res.json()) as {
      summary?: PersonaSummary;
      persona?: unknown;
      agent?: unknown;
      bundle?: ResolvedPersona["bundle"];
      fallback?: { reason?: string };
    };
    if (!payload.summary) throw new Error("resolve returned no summary");
    const sourceUrl = url ?? payload.summary.sourceUrl;
    // The route returns HTTP 200 with a fallback summary when the persona was
    // fetched but couldn't be statically parsed/compiled. Surface that reason
    // (and flag it as demo) instead of rendering the empty fallback summary as
    // if it were a real persona — otherwise e.g. integrations silently show as
    // "none" when the persona actually declares them.
    const serverFallbackReason = payload.fallback?.reason;
    return {
      summary: {
        ...payload.summary,
        sourceUrl,
        imageUrl: payload.summary.imageUrl ?? cardImageFromPersonaUrl(sourceUrl),
      },
      persona: payload.persona,
      agent: payload.agent,
      bundle: payload.bundle,
      demo: serverFallbackReason !== undefined,
      ...(serverFallbackReason !== undefined ? { fallbackReason: serverFallbackReason } : {}),
    };
  } catch (error) {
    // Graceful degradation — show the demo summary, flag it as demo so the
    // deploy step knows it can't do a live bundle deploy.
    return {
      summary: demoPersonaForUrl(url),
      demo: true,
      fallbackReason: error instanceof Error ? error.message : "Unknown resolve error",
    };
  }
}

/**
 * Map a non-OK resolve status onto a blocking `resolveError`, or null when the
 * failure should degrade softly to demo data. Mirrors the route contract:
 * 401 → `PersonaResolveAuthRequiredError`, 403 → `PersonaResolveGithubAuthError`.
 */
function resolveBlockingError(status: number, message: string): PersonaResolveError | null {
  if (status === 401) {
    return { status, kind: "auth-required", message };
  }
  if (status === 403) {
    return { status, kind: "no-access", message };
  }
  return null;
}

/**
 * Surface the server's detailed reason (e.g. "GitHub authentication is
 * required…" / "No GitHub integration credential can read…") so private-repo
 * auth failures explain themselves in the wizard instead of a bare status code.
 */
async function resolveErrorMessage(res: Response): Promise<string> {
  const detail = await res
    .json()
    .then((body) =>
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : null,
    )
    .catch(() => null);
  return detail ?? `resolve failed: ${res.status}`;
}
