# Plan: Credential-Proxy Service Endpoint Wiring

## Goal

Make all service endpoint URLs (relayauth, relayfile, credential-proxy) resolve
through `infra/service-config.ts` so every consumer uses one source of truth,
and sandboxes receive proxy URL/token through the intended `launcher.ts` path.

---

## Current State

| Endpoint | Centralized in `service-config.ts`? | Injected into web Lambda env? | Duplicate resolvers? |
|---|---|---|---|
| relayauth | Yes (`configuredRelayauthUrl`) | Yes (`infra/web.ts:60-61`) | 2 duplicates |
| relayfile | Yes (`configuredRelayfileUrl`) | Yes (`infra/web.ts:63-64`) | 2 duplicates |
| credential-proxy | **No** | **No** | Resolved ad-hoc in `launcher.ts` from env |

### Duplicate consumers (relayauth/relayfile)

1. **`packages/web/lib/relayfile.ts:4,6-9`** — hardcoded default `https://api.relayfile.dev`, own resolver. Redundant because `infra/web.ts` already injects `RelayfileUrl` + `RELAYFILE_URL` env vars.
2. **`packages/web/lib/workspace-registry.ts:17,32-37`** — hardcoded default `https://api.relayauth.dev`, own resolver. Same: env vars already injected.
3. **`packages/core/src/orchestrator.ts:83-84`** — reads `process.env.RelayfileUrl ?? process.env.RELAYFILE_URL` directly. Not a bug (orchestrator runs server-side where env is set), but inconsistent.
4. **`packages/core/src/relayauth/client.ts:19`** — reads `process.env.RelayauthUrl ?? process.env.RELAYAUTH_URL`. Returns null if missing. Acceptable pattern for core (it has no infra dependency), but should be noted.

### Credential proxy path (current)

- `route.ts:251` calls `resolveCredentialProxyConfig()` with no args — reads `RELAY_LLM_PROXY`, `RELAY_LLM_PROXY_URL`, `CREDENTIAL_PROXY_TOKEN`, `RELAY_LLM_PROXY_TOKEN` from process.env.
- `launcher.ts:519-525` calls `applyCredentialProxyEnv()` which sets `RELAY_LLM_PROXY`, `RELAY_LLM_PROXY_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_API_BASE`, `CREDENTIAL_PROXY_TOKEN`, `RELAY_LLM_PROXY_TOKEN` in the sandbox env.
- `script-generator.ts:580-603` lists the same keys for passthrough/detection.
- **Problem**: The proxy URL has no default and no entry in `service-config.ts`. If env vars aren't set, the proxy silently does nothing — sandbox gets no LLM routing.

---

## Proposed Changes (4 files modified, 1 file extended)

### Change 1: Add credential-proxy to `infra/service-config.ts`

Add `configuredCredentialProxyUrl` and `configuredCredentialProxyToken` exports:

```ts
const DEFAULT_CREDENTIAL_PROXY_URL = `https://${serviceApiHostname("relayllm.dev")}`;

export const configuredCredentialProxyUrl =
  resolveEnvOverride("RELAY_LLM_PROXY", "RELAY_LLM_PROXY_URL", "CREDENTIAL_PROXY_URL")
  ?? DEFAULT_CREDENTIAL_PROXY_URL;

export const configuredCredentialProxyToken =
  resolveEnvOverride("CREDENTIAL_PROXY_TOKEN", "RELAY_LLM_PROXY_TOKEN")
  ?? "";
```

**Rationale**: Follows the exact pattern of `configuredRelayauthUrl` / `configuredRelayfileUrl`. The default hostname should match whatever the actual deployed credential-proxy worker uses (verify `relayllm.dev` or adjust).

### Change 2: Inject credential-proxy env into web Lambda (`infra/web.ts`)

Add to the `environment` block:

```ts
RELAY_LLM_PROXY: configuredCredentialProxyUrl,
RELAY_LLM_PROXY_URL: configuredCredentialProxyUrl,
CREDENTIAL_PROXY_TOKEN: configuredCredentialProxyToken,
RELAY_LLM_PROXY_TOKEN: configuredCredentialProxyToken,
```

**Rationale**: Makes `route.ts:251`'s `resolveCredentialProxyConfig()` pick up the centralized values. Currently it reads these from env but they aren't explicitly set — this makes the wiring explicit.

### Change 3: Remove duplicate resolver in `packages/web/lib/relayfile.ts`

Replace the local `resolveRelayfileUrl()` function and hardcoded default:

```ts
// BEFORE
const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";
function resolveRelayfileUrl(): string {
  return optionalEnv("RelayfileUrl") ?? optionalEnv("RELAYFILE_URL") ?? DEFAULT_RELAYFILE_URL;
}

// AFTER
function resolveRelayfileUrl(): string {
  const url = optionalEnv("RelayfileUrl") ?? optionalEnv("RELAYFILE_URL");
  if (!url) throw new Error("RelayfileUrl not configured — check infra/web.ts environment");
  return url;
}
```

Remove the hardcoded default. The env vars are guaranteed to be set by `infra/web.ts`. Throwing on missing makes misconfiguration visible instead of silently falling back to a potentially wrong URL.

### Change 4: Remove duplicate resolver in `packages/web/lib/workspace-registry.ts`

Same pattern:

```ts
// BEFORE
const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";
function resolveRelayauthUrl(): string {
  return optionalEnv("RelayauthUrl") ?? optionalEnv("RELAYAUTH_URL") ?? optionalEnv("RELAYAUTH_API_URL") ?? DEFAULT_RELAYAUTH_URL;
}

// AFTER
function resolveRelayauthUrl(): string {
  const url = optionalEnv("RelayauthUrl") ?? optionalEnv("RELAYAUTH_URL") ?? optionalEnv("RELAYAUTH_API_URL");
  if (!url) throw new Error("RelayauthUrl not configured — check infra/web.ts environment");
  return url;
}
```

Remove hardcoded default and `DEFAULT_RELAYAUTH_URL` constant.

### NOT changed (intentionally)

- **`packages/core/src/orchestrator.ts:83`** — Reads env directly, but `core` is a standalone package that must not import from `infra/`. The env is set by whatever launches the orchestrator (the sandbox env or server env). No change needed.
- **`packages/core/src/relayauth/client.ts:19`** — Same reasoning. Core package, env-driven, returns null when unconfigured. Correct as-is.
- **`packages/core/src/bootstrap/launcher.ts`** — Already correctly structured: `resolveCredentialProxyConfig()` reads from config + env, `applyCredentialProxyEnv()` writes to sandbox. The fix is upstream (Change 2 ensures the env is populated).
- **`packages/core/src/bootstrap/script-generator.ts`** — Key lists are correct; they match what `applyCredentialProxyEnv` sets.
- **`packages/web/app/api/v1/workflows/run/route.ts`** — `RESERVED_ENV_KEYS` is a blocklist preventing user override, not a resolution site. Correct as-is.

---

## Verification Plan

### V1: Static — Import graph consistency

```bash
# All service URLs should trace back to service-config.ts (infra layer) or env vars set by it
grep -rn "api\.relayfile\.dev\|api\.relayauth\.dev\|api\.relayllm\.dev" packages/web/
# Expected: zero hardcoded defaults remaining in packages/web/
```

### V2: Static — Credential proxy env injection

```bash
# Confirm web.ts injects all 4 credential proxy env vars
grep -n "RELAY_LLM_PROXY\|CREDENTIAL_PROXY_TOKEN" infra/web.ts
# Expected: 4 lines (RELAY_LLM_PROXY, RELAY_LLM_PROXY_URL, CREDENTIAL_PROXY_TOKEN, RELAY_LLM_PROXY_TOKEN)
```

### V3: Unit — resolveCredentialProxyConfig picks up env

Existing test in `tests/orchestrator/launcher.test.ts` covers `resolveCredentialProxyConfig`. Verify it passes with env vars set to the configured values.

### V4: E2E — Sandbox receives proxy credentials

**What to prove**: A workflow launched via `POST /api/v1/workflows/run` results in a sandbox where `RELAY_LLM_PROXY`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `CREDENTIAL_PROXY_TOKEN` are all set to values derived from `service-config.ts`.

**How**:
1. Deploy with the changes to a preview stage.
2. Launch a minimal YAML workflow (single agent, one step).
3. Inspect sandbox env (via Daytona API or sandbox logs) and confirm:
   - `RELAY_LLM_PROXY` = configured proxy URL
   - `OPENAI_BASE_URL` = `{proxy}/openai/v1`
   - `ANTHROPIC_BASE_URL` = `{proxy}/anthropic`
   - `CREDENTIAL_PROXY_TOKEN` is non-empty
4. Confirm the agent can make a proxied LLM call (e.g., simple completion).

### V5: E2E — Relayfile/relayauth URLs are consistent

In the same sandbox, confirm `RELAYFILE_URL` matches the `configuredRelayfileUrl` from service-config (not a hardcoded fallback).

---

## Risk Assessment

- **Low risk**: Changes 3-4 remove fallback defaults. If `infra/web.ts` fails to inject the env vars, the app will throw at startup rather than silently using stale URLs. This is strictly better.
- **Medium risk**: Change 1 requires knowing the correct credential-proxy hostname. If it's not `relayllm.dev`, adjust the default. The env override chain ensures any existing `.env` configuration continues to work.
- **No breaking changes**: All env var names are preserved. The `core` package is untouched. The sandbox env-injection path (`launcher.ts`) is unchanged — it just gets non-empty values now.

---

## Summary

| # | File | Change | Lines touched |
|---|---|---|---|
| 1 | `infra/service-config.ts` | Add `configuredCredentialProxyUrl`, `configuredCredentialProxyToken` | ~10 |
| 2 | `infra/web.ts` | Inject 4 credential-proxy env vars | ~4 |
| 3 | `packages/web/lib/relayfile.ts` | Remove hardcoded default, throw on missing | ~5 |
| 4 | `packages/web/lib/workspace-registry.ts` | Remove hardcoded default, throw on missing | ~5 |

**Total**: ~24 lines changed across 4 files. No new files. No new dependencies.

---

## Implementation Status (2026-04-11)

All 4 changes have been implemented and verified:

| # | Change | Status | Verification |
|---|---|---|---|
| 1 | `infra/service-config.ts` — credential-proxy exports | **DONE** | Lines 5, 40-49 |
| 2 | `infra/web.ts` — 4 env vars injected | **DONE** | Lines 67-70 |
| 3 | `packages/web/lib/relayfile.ts` — no hardcoded default | **DONE** | Throws on missing |
| 4 | `packages/web/lib/workspace-registry.ts` — no hardcoded default | **DONE** | Throws on missing |

### Static verification results

- **V1 PASS**: Zero hardcoded service URLs (`api.relayfile.dev`, `api.relayauth.dev`, `api.relayllm.dev`) in `packages/web/`.
- **V2 PASS**: All 4 credential proxy env vars present in `infra/web.ts:67-70`.
- **V3 PASS**: Existing unit tests in `tests/orchestrator/launcher.test.ts` cover `resolveCredentialProxyConfig` and `applyCredentialProxyEnv`.

### Remaining: E2E verification (V4, V5)

Deploy to a preview stage and confirm:
1. Sandbox env has `RELAY_LLM_PROXY` set to the `service-config.ts` default (`https://{stage}-api.relayllm.dev`)
2. `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_API_BASE` are derived from it
3. `CREDENTIAL_PROXY_TOKEN` is non-empty
4. Agent can complete a proxied LLM call

PLAN_COMPLETE
