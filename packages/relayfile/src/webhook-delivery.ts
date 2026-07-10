import { normalizePath } from "@relayfile/core";
export const MAX_WEBHOOK_SUBSCRIPTIONS_PER_WORKSPACE = 32;
export const MAX_WEBHOOK_GLOBS_PER_SUBSCRIPTION = 32;
export const MAX_WEBHOOK_FANOUT_PER_EVENT = 100;

export type OutboundWebhookUrlValidation =
  | {
      ok: true;
      url: string;
      hostname: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export function normalizeWebhookPathGlob(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") {
    return "/**";
  }
  return normalizePath(trimmed);
}

export function eventMatchesWebhookGlob(
  eventPath: string,
  glob: string,
): boolean {
  const normalizedPath = normalizePath(eventPath);
  const normalizedGlob = normalizeWebhookPathGlob(glob);
  if (normalizedGlob === "/**") {
    return true;
  }
  if (normalizedGlob === normalizedPath) {
    return true;
  }
  if (normalizedGlob.endsWith("/**")) {
    const prefix = normalizePath(normalizedGlob.slice(0, -"/**".length));
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedGlob.endsWith("/*")) {
    const prefix = normalizePath(normalizedGlob.slice(0, -"/*".length));
    const suffix = normalizedPath.slice(prefix.length);
    return (
      normalizedPath.startsWith(`${prefix}/`) && !suffix.slice(1).includes("/")
    );
  }
  if (normalizedGlob.endsWith("*")) {
    return normalizedPath.startsWith(normalizedGlob.slice(0, -1));
  }
  return false;
}

export function eventMatchesAnyWebhookGlob(
  eventPath: string,
  globs: readonly string[],
): boolean {
  return globs.some((glob) => eventMatchesWebhookGlob(eventPath, glob));
}

export function validateOutboundWebhookUrl(
  rawUrl: string,
  hostAllowlist?: string,
): OutboundWebhookUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "webhook url must be an absolute https URL",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "webhook url must use https",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "webhook url must not contain credentials",
    };
  }
  if (url.hash) {
    url.hash = "";
  }

  const hostname = url.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "webhook url host is not allowed",
    };
  }

  const allowedHosts = parseHostAllowlist(hostAllowlist);
  if (
    allowedHosts.length > 0 &&
    !hostMatchesAllowlist(hostname, allowedHosts)
  ) {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "webhook url host is not in the allowlist",
    };
  }

  return {
    ok: true,
    url: url.toString(),
    hostname,
  };
}

export function queueNameMatchesWebhookDelivery(queue: string): boolean {
  return (
    queue === "relayfile-webhooks" || queue.startsWith("relayfile-webhooks-")
  );
}

function parseHostAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesAllowlist(
  hostname: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === entry;
  });
}

function isBlockedHostname(hostname: string): boolean {
  const withoutBrackets = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (
    withoutBrackets === "localhost" ||
    withoutBrackets.endsWith(".localhost") ||
    withoutBrackets === "local" ||
    withoutBrackets.endsWith(".local")
  ) {
    return true;
  }
  if (isPrivateIpv4(withoutBrackets) || isPrivateIpv6(withoutBrackets)) {
    return true;
  }
  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255 ? parsed : Number.NaN;
  });
  if (octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (!normalized.includes(":")) return false;
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/i.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const ipv4Part = normalized.slice(7);
    if (ipv4Part.includes(".")) return isPrivateIpv4(ipv4Part);
    return true;
  }
  return false;
}
