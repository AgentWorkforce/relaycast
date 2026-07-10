export type PersonaIntegrationSource =
  | { kind: "deployer_user" }
  | { kind: "workspace" }
  | { kind: "workspace_service_account"; name: string };

export type PersonaIntegrationConfigWithSource = {
  source?: PersonaIntegrationSource | null;
  [key: string]: unknown;
};

const DEFAULT_SOURCE: PersonaIntegrationSource = { kind: "deployer_user" };

export function normalizePersonaIntegrationSource(
  config: PersonaIntegrationConfigWithSource | null | undefined,
): PersonaIntegrationSource {
  const source = config?.source;
  if (source === undefined || source === null) {
    return DEFAULT_SOURCE;
  }
  if (typeof source !== "object") {
    throw new Error("integration source must be an object.");
  }
  if (source.kind === "workspace_service_account") {
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name) {
      throw new Error("workspace_service_account integration source requires a non-empty name.");
    }
    return { kind: "workspace_service_account", name };
  }
  if (source.kind === "workspace" || source.kind === "deployer_user") {
    return { kind: source.kind };
  }
  throw new Error(
    `Unknown integration source kind: ${(source as { kind?: unknown }).kind ?? "unknown"}`,
  );
}
