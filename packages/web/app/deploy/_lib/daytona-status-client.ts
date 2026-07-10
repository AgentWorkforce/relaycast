import { toAppPath } from "@/lib/app-path";

/**
 * Daytona connect for the web deploy wizard.
 *
 * Daytona's credential is captured out-of-band by the relay CLI
 * (`agent-relay cloud connect daytona` → local `daytona login` → normalized
 * token uploaded to the cloud credential-store), NOT a Nango OAuth popup. So
 * the wizard can't open a Nango `sessionUrl` for it (the connect-session route
 * 409s — daytona isn't a Nango provider). Instead the daytona row instructs the
 * operator to run the CLI command in their terminal and POLLS this status route
 * until the credential lands.
 *
 * Keep `CLI_CAPTURED_PROVIDERS` in sync with the relay CLI's `CLI_AUTH_CONFIG`
 * capture providers and the `agentworkforce deploy` walker's equivalent set.
 */
export const CLI_CAPTURED_PROVIDERS = new Set<string>(["daytona"]);

export function isCliCapturedProvider(provider: string): boolean {
  return CLI_CAPTURED_PROVIDERS.has(provider);
}

/** The terminal command an operator runs to capture the daytona credential. */
export const DAYTONA_CONNECT_COMMAND = "agent-relay cloud connect daytona";

/**
 * Mirror of the `agentworkforce deploy` CLI's `isConnectedStatus` predicate
 * (workforce `packages/deploy/src/connect.ts`). A provider counts as connected
 * when the cloud confirms the canonical credential exists: `oauth.connected`,
 * or a top-level `ready`/`state:"ready"`/`status:"ready"` signal. A
 * `connectionMatched:false` poll for a specific setup session is not connected.
 *
 * Cloud-Cred's `/integrations/daytona/status` route returns
 * `ready:true` + `state:"ready"` + `oauth.connected:true` once both the
 * `provider_credentials` row and the encrypted store object exist; otherwise
 * `ready:false` + `state:"pending"` + `oauth.connected:false`.
 */
export function isDaytonaConnectedStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.connectionMatched === false) return false;

  const oauth = record.oauth;
  if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
    if ((oauth as Record<string, unknown>).connected === true) return true;
  }

  return record.status === "ready" || record.state === "ready" || record.ready === true;
}

/**
 * The persona-integration source the wizard checks. The web deploy wizard
 * connects integrations for the deploying operator, mirroring the CLI default
 * (`scope=deployer_user`). Cloud-Cred's route treats daytona as scope-agnostic
 * (credential-backed for the deploying user/workspace), so this is belt-and-
 * suspenders alignment with the CLI poll.
 */
export const DAYTONA_STATUS_SCOPE = "deployer_user";

export async function fetchDaytonaStatus(
  workspaceId: string,
  scope: string = DAYTONA_STATUS_SCOPE,
): Promise<unknown> {
  const response = await fetch(
    toAppPath(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/daytona/status?scope=${encodeURIComponent(scope)}`,
    ),
    {
      cache: "no-store",
      credentials: "include",
    },
  );
  if (!response.ok) {
    throw new Error("Failed to load Daytona connection status.");
  }
  return (await response.json()) as unknown;
}

export async function checkDaytonaConnected(
  workspaceId: string,
  scope: string = DAYTONA_STATUS_SCOPE,
): Promise<boolean> {
  const status = await fetchDaytonaStatus(workspaceId, scope);
  return isDaytonaConnectedStatus(status);
}
