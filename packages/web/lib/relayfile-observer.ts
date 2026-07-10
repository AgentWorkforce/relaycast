export const RELAYFILE_OBSERVER_PATH = "/observer/file";
export const RELAYFILE_OBSERVER_AGENT_NAME = "cloud-dashboard-observer";
export const RELAYFILE_OBSERVER_TOKEN_TTL_SECONDS = 60 * 60;
export const RELAYFILE_OBSERVER_SCOPES = ["fs:read", "fs:write", "sync:read", "sync:trigger"] as const;

export type RelayfileObserverLaunchConfig = {
  baseUrl: string;
  token: string;
  workspaceId: string;
};

export type RelayfileObserverAuth = {
  source: string;
  context?: {
    workspaces?: readonly { id: string }[];
  };
};

export function canLaunchRelayfileObserver(
  auth: RelayfileObserverAuth | null | undefined,
  workspaceId: string,
): boolean {
  return (
    auth?.source === "session" &&
    (auth.context?.workspaces?.some((workspace) => workspace.id === workspaceId) ?? false)
  );
}

export function buildRelayfileObserverFragment(config: RelayfileObserverLaunchConfig): string {
  const fragment = new URLSearchParams();
  fragment.set("baseUrl", config.baseUrl.trim().replace(/\/+$/, ""));
  fragment.set("token", config.token.trim());
  fragment.set("workspaceId", config.workspaceId.trim());
  return fragment.toString();
}

export function buildRelayfileObserverLaunchUrl(
  origin: string,
  config: RelayfileObserverLaunchConfig,
): string {
  const observerUrl = new URL(RELAYFILE_OBSERVER_PATH, origin);
  return `${observerUrl.toString()}#${buildRelayfileObserverFragment(config)}`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function serializeScriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildRelayfileObserverLaunchHtml(launchUrl: string): string {
  const target = new URL(launchUrl).toString();
  const htmlTarget = escapeHtmlAttribute(target);
  const scriptTarget = serializeScriptString(target);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0; url=${htmlTarget}">`,
    "<title>Opening RelayFile observer</title>",
    "</head>",
    "<body>",
    `<script>window.location.replace(${scriptTarget});</script>`,
    "</body>",
    "</html>",
  ].join("");
}

function readForwardedHeader(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function isTrustedRelayfileObserverHost(hostname: string): boolean {
  return (
    hostname === "agentrelay.com" ||
    hostname.endsWith(".agentrelay.com") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1"
  );
}

function canonicalizeRelayfileObserverOrigin(origin: string): string {
  return new URL(origin).origin;
}

export function resolveRelayfileObserverPublicOrigin(headers: Headers, fallbackOrigin: string): string {
  const fallback = canonicalizeRelayfileObserverOrigin(fallbackOrigin);
  const forwardedHost =
    readForwardedHeader(headers.get("x-forwarded-host")) ||
    readForwardedHeader(headers.get("x-original-host"));
  if (!forwardedHost) {
    return fallback;
  }

  const forwardedProto = readForwardedHeader(headers.get("x-forwarded-proto"));
  const protocol = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "https";
  try {
    const origin = canonicalizeRelayfileObserverOrigin(`${protocol}://${forwardedHost}`);
    const hostname = new URL(origin).hostname;
    return isTrustedRelayfileObserverHost(hostname) ? origin : fallback;
  } catch {
    return fallback;
  }
}
