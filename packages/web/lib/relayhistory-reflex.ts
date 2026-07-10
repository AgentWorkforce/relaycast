import {
  createRelayhistorySession,
  resolveRelayhistoryAssertionApiKey,
  resolveRelayhistoryUrl,
  type RelayhistorySessionRequest,
} from "./relayhistory-session";

export { resolveRelayhistoryAssertionApiKey, resolveRelayhistoryUrl };

export async function fetchRelayhistoryReflex(
  path: string,
  session: RelayhistorySessionRequest,
): Promise<Response> {
  const { accessToken } = await createRelayhistorySession({
    ...session,
    mode: "read",
  });
  const url = `${resolveRelayhistoryUrl()}${path}`;

  return globalThis.fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}
