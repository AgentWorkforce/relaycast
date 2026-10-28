import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import type { AdmissionAction, AdmissionDenial } from '../ports/admission.js';
import type { Workspace } from '../ports/auth.js';
import { createRegistrationAdmission, type RegistrationAdmission } from '../engine/registrationAdmission.js';
import { AdmissionDeniedError } from '../lib/admissionError.js';
import { setRetryContract } from '../lib/throttle.js';
import { runInBackground } from '../routes/background.js';

/**
 * Ask the host whether `action` may proceed. No hook, or a hook that throws,
 * admits it: a host's metering outage must not take messaging down.
 */
export async function resolveAdmission(
  c: Context<AppEnv>,
  workspace: Workspace,
  action: AdmissionAction,
): Promise<AdmissionDenial | null> {
  const admission = c.get('engine').admission;
  if (!admission?.admit) return null;
  try {
    return (await admission.admit({ workspace, action })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Render a denial as the error envelope, with `Retry-After` when the host gave
 * one. Without `retryAt` no retry clears the denial, so the per-minute reset
 * `rateLimit` already set is withdrawn rather than advertised.
 */
export function admissionDeniedResponse(c: Context, denial: AdmissionDenial) {
  if (denial.retryAt !== undefined && Number.isFinite(denial.retryAt)) {
    setRetryContract(c, denial.retryAt);
  } else {
    c.header('X-RateLimit-Reset', undefined);
    c.header('Retry-After', undefined);
  }
  return c.json(
    { ok: false, error: { ...denial.details, code: denial.code, message: denial.message } },
    denial.status as ContentfulStatusCode,
  );
}

/** Report a successful, non-replayed action to the host without holding the response. */
export function reportCommitted(c: Context<AppEnv>, workspace: Workspace, action: AdmissionAction): void {
  const admission = c.get('engine').admission;
  if (!admission?.committed) return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  if (c.res.headers.get('Idempotency-Replayed') === 'true') return;
  runInBackground(
    c,
    Promise.resolve().then(() => admission.committed!({ workspace, action })),
    `admission committed: ${action}`,
  );
}

/**
 * Admit message sends through the host's `message` hook.
 *
 * Mounted after `rateLimit` on the routes that create a message (channel post,
 * DM, group DM, thread reply). Idempotency is preserved: a denied request
 * without an `Idempotency-Key` is refused here; a keyed one reaches the route
 * so a replay of an earlier successful send still returns its stored receipt,
 * and the route refuses only a fresh send ({@link assertMessageAdmitted},
 * called inside the idempotent operation). Only a fresh successful send is
 * reported as committed.
 */
export const admitMessage = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (!workspace || !c.get('engine').admission) { await next(); return; }

  const denial = await resolveAdmission(c, workspace, 'message');
  if (denial) {
    if (!c.req.header('Idempotency-Key')) return admissionDeniedResponse(c, denial);
    c.set('messageAdmissionDenial', denial);
  }

  await next();

  reportCommitted(c, workspace, 'message');
});

/**
 * Refuse a fresh send when `admitMessage` found it denied. Call it first inside
 * a message route's idempotent `operation`, which runs only for a new send —
 * never for a replay of a stored receipt.
 */
export function assertMessageAdmitted(c: Context<AppEnv>): void {
  const denial = c.get('messageAdmissionDenial');
  if (denial) throw new AdmissionDeniedError(denial);
}

/**
 * The registration admission for the authenticated workspace, or `undefined`
 * when the host has no `admit` hook. Pass it to the node and agent
 * registration paths, which consult it only for a NEW registration.
 */
export function registrationAdmission(c: Context<AppEnv>): RegistrationAdmission | undefined {
  return createRegistrationAdmission({
    db: c.get('db'),
    admission: c.get('engine').admission,
    workspace: c.get('workspace'),
  });
}
