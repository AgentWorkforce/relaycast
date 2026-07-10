import { deploymentPersonaSpec } from "@cloud/core/proactive-runtime/agent-spec.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (!isRecord(value)) return false;
  return value.enabled !== false;
}

export function isConflictResolvePersona(spec: unknown): boolean {
  const persona = deploymentPersonaSpec(spec) ?? (isRecord(spec) ? spec : null);
  const capabilities = isRecord(persona?.capabilities) ? persona.capabilities : null;
  return capabilityEnabled(capabilities?.conflictResolve);
}
