import { tryResourceValue } from "@/lib/env";

export const CONTINUATION_RESUME_ENABLED_ENV =
  "PROACTIVE_CONTINUATION_RESUME_ENABLED";
export const CONTINUATION_RESUME_ENABLED_RESOURCE =
  "ProactiveContinuationResumeEnabled";
export const CONTINUATION_RESUME_TEST_ENV =
  "PROACTIVE_CONTINUATION_RESUME_TEST_MODE";

export function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled"
  );
}

export function isProactiveContinuationResumeEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(CONTINUATION_RESUME_ENABLED_RESOURCE) ??
      readProcessEnvString(CONTINUATION_RESUME_ENABLED_ENV) ??
      readProcessEnvString(CONTINUATION_RESUME_TEST_ENV),
  );
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env[name];
}
