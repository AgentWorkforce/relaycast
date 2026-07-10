export type ApiTokenSubjectType = "sandbox" | "cli" | "ci";

export const CI_DEPLOYMENTS_READ_SCOPE = "deployments:ci:read" as const;
export const CI_DEPLOYMENTS_WRITE_SCOPE = "deployments:ci:write" as const;
export const CI_DEPLOYMENT_SCOPES = [
  CI_DEPLOYMENTS_READ_SCOPE,
  CI_DEPLOYMENTS_WRITE_SCOPE,
] as const;
