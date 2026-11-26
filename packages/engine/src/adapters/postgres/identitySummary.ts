import type { PostgresMode } from "./config.js";
import type { IdentityCheck, IdentityResult } from "./identity.js";

/** Error code shared with relay-control and sessions-pipeline for a wrong database login. */
export const DB_LOGIN_ERROR_CODE = "AR_DB_LOGIN";

/** Troubleshooting page shared with relay-control and sessions-pipeline. */
export const DB_LOGIN_DOCS_URL =
  "https://agentrelay.com/docs/self-hosting/troubleshooting#database-logins";

/** Role attributes a master/superuser login has and a relaycast login must not. */
const MASTER_ATTRIBUTE_CHECKS: Record<string, string> = {
  not_superuser: "SUPERUSER",
  not_createrole: "CREATEROLE",
  not_createdb: "CREATEDB",
  not_replication: "REPLICATION",
  not_bypassrls: "BYPASSRLS",
};

/** Managed-service admin roles that only a master login is a member of. */
const MANAGED_ADMIN_ROLES = new Set([
  "rds_superuser",
  "azure_pg_admin",
  "cloudsqlsuperuser",
  "alloydbsuperuser",
]);

function listAfter(detail: string, prefix: string): string[] {
  const at = detail.indexOf(prefix);
  if (at < 0) return [];
  return detail
    .slice(at + prefix.length)
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
}

/** The value of `<name>=<value>, expected <role>` in a session_user/current_user detail. */
function parseWho(check: IdentityCheck | undefined): {
  actual?: string;
  expected?: string;
} {
  const match = check?.detail.match(/^[a-z_]+=(.*), expected (.*)$/);
  return match ? { actual: match[1], expected: match[2] } : {};
}

/**
 * A one-line, operator-facing summary of a failed {@link verifyIdentity}
 * result, led by the shared `AR_DB_LOGIN` code and troubleshooting link, so
 * the root cause (usually "the master login was used") is readable before
 * the per-check list. Returns `null` when the result passed.
 *
 * Pure: it only reads `result.checks` (names and details as verifyIdentity
 * reports them), so other tooling can reuse it on a result it obtained
 * itself. `expectedRole` defaults to the role named in the `session_user`
 * check.
 */
export function summarizeIdentityFailure(
  result: IdentityResult,
  mode: PostgresMode,
  expectedRole?: string,
): string | null {
  const failed = result.checks.filter((check) => !check.ok);
  if (result.ok || failed.length === 0) return null;
  const byName = new Map(result.checks.map((check) => [check.name, check]));
  const failedByName = new Map(failed.map((check) => [check.name, check]));

  const sessionCheck = byName.get("session_user");
  const parsed = parseWho(sessionCheck);
  const expected = expectedRole ?? parsed.expected ?? `relaycast_${mode}`;
  const login =
    sessionCheck && sessionCheck.ok ? expected : (parsed.actual ?? "unknown");

  // Master/superuser shape: role attributes, privileged roles it can reach,
  // or membership in a managed-service admin role (rds_superuser, ...).
  const attributes = Object.entries(MASTER_ATTRIBUTE_CHECKS)
    .filter(([name]) => failedByName.has(name))
    .map(([, attribute]) => attribute);
  const privilegedRoles = listAfter(
    failedByName.get("no_privileged_memberships")?.detail ?? "",
    "can reach privileged role(s): ",
  );
  const adminRoles = listAfter(
    failedByName.get("no_role_memberships")?.detail ?? "",
    "by membership or SET ROLE: ",
  ).filter((role) => MANAGED_ADMIN_ROLES.has(role));
  const reachable = [...new Set([...privilegedRoles, ...adminRoles])];
  const reasons: string[] = [];
  if (attributes.length > 0) reasons.push(`has ${attributes.join(", ")}`);
  if (reachable.length > 0) reasons.push(`can reach ${reachable.join(", ")}`);
  const fix = `Run scripts/selfhost/configure-rds.sh (AgentWorkforce/infra), or see ${DB_LOGIN_DOCS_URL}`;

  if (reasons.length > 0) {
    if (login === expected) {
      return (
        `${DB_LOGIN_ERROR_CODE}: login "${login}" has master/superuser privileges (${reasons.join("; ")}); ` +
        `a relaycast ${mode} login must not. ${fix}`
      );
    }
    return (
      `${DB_LOGIN_ERROR_CODE}: login "${login}" is the database master/superuser (${reasons.join("; ")}); ` +
      `relaycast needs a dedicated ${mode} login (${expected}). ${fix}`
    );
  }

  const names = failed.map((check) => check.name).join(", ");
  if (login !== expected) {
    return (
      `${DB_LOGIN_ERROR_CODE}: logged in as "${login}" but relaycast ${mode} expects login "${expected}" ` +
      `(failed: ${names}). See ${DB_LOGIN_DOCS_URL}`
    );
  }
  return (
    `${DB_LOGIN_ERROR_CODE}: login "${login}" is not a correctly scoped relaycast ${mode} identity ` +
    `(failed: ${names}). See ${DB_LOGIN_DOCS_URL}`
  );
}
