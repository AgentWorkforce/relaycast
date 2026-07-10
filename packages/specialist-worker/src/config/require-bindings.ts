/**
 * Fail-fast validation of required Worker bindings.
 *
 * Motivation: it is possible for every layer of infra wiring to be
 * individually correct while the final deploy still has an empty
 * binding on the running Worker. We hit this on 2026-04-24 when
 * `SPECIALIST_RELAYAUTH_API_KEY` was set in GH secrets, declared in
 * `infra/secrets.ts`, bound in `infra/specialist-worker.ts`, and seeded
 * by `seed-sst-secrets.sh`, but the reusable deploy workflow never
 * exported the env var into the runner shell. The seed script's
 * empty-default kicked in, SST stamped "" into the binding, and the
 * runtime failure was the first signal that anything was wrong —
 * hours after deploy, visible only as a generic error to a real user.
 *
 * Remediation: check required bindings on every request. The first
 * request post-deploy (including a post-deploy smoke test) surfaces a
 * clear configuration error instead of a generic downstream failure.
 *
 * Not a type-system guarantee — bindings are runtime values. The
 * declaration here IS the source of truth for "this worker requires
 * these to start." Keep it in sync with the worker's routes.
 */
export const REQUIRED_SPECIALIST_BINDINGS = [
  "OPENROUTER_API_KEY",
  "SPECIALIST_RELAYAUTH_URL",
  "SPECIALIST_RELAYAUTH_API_KEY",
] as const;

export type RequiredSpecialistBinding = (typeof REQUIRED_SPECIALIST_BINDINGS)[number];

export interface MissingBindingReport {
  missing: RequiredSpecialistBinding[];
  configError: Error;
}

/**
 * Returns `null` when every required binding has a non-empty string
 * value, or a report containing the missing names + a pre-built Error
 * suitable for throwing/logging.
 *
 * The error's `code` is `specialist_configuration_error` to match the
 * existing SpecialistInternalError code so downstream error handling
 * stays consistent.
 */
export function checkRequiredSpecialistBindings(
  bindings: Record<string, string | undefined> | undefined,
): MissingBindingReport | null {
  const source = bindings ?? {};
  const missing: RequiredSpecialistBinding[] = [];
  for (const name of REQUIRED_SPECIALIST_BINDINGS) {
    const raw = source[name];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      missing.push(name);
    }
  }
  if (missing.length === 0) return null;

  const names = missing.join(", ");
  const message =
    `[specialist/config] Required bindings missing or empty: ${names}. ` +
    `The worker cannot serve requests until these are wired end-to-end ` +
    `(GH secret -> workflow env passthrough -> seed-sst-secrets.sh -> ` +
    `infra/specialist-worker.ts -> deployed Worker binding).`;
  const configError = Object.assign(new Error(message), {
    code: "specialist_configuration_error",
    missingBindings: missing,
  });
  return { missing, configError };
}
