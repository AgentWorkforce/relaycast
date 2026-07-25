import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  extractActorIdentity,
  extractAgentRelayDistinctId,
  extractOriginActor,
  requiredOriginInfo,
  UNKNOWN_ORIGIN_ACTOR,
} from "./origin.js";

type ServerEvent = `relaycast_server_${string}`;

export function normalizeRoutePathForTelemetry(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const compact = withoutQuery.replace(/\/+/g, "/").trim();
  const withLeadingSlash = compact.startsWith("/") ? compact : `/${compact}`;
  const segments = withLeadingSlash
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (/^\d{6,}$/.test(segment)) return ":id";
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          segment,
        )
      )
        return ":id";
      if (/^(dm|dmch|cmd|sub|wh)_[a-zA-Z0-9_-]{8,}$/.test(segment))
        return ":id";
      return segment;
    });
  return `/${segments.join("/")}`;
}

/**
 * Emit a server-side product-telemetry event through the injected
 * {@link TelemetrySink}. Self-host's default sink is a no-op; cloud injects
 * PostHog. The sink owns batching/background-flush, so this returns immediately.
 */
export function emitServerEvent(
  c: Context<AppEnv>,
  workspaceId: string,
  event: ServerEvent,
  properties: Record<string, unknown>,
): void {
  const normalizedProperties = { ...properties };
  if (typeof normalizedProperties.route_path === "string") {
    normalizedProperties.route_path = normalizeRoutePathForTelemetry(
      normalizedProperties.route_path,
    );
  }

  // Prefer the value stashed by the logger middleware. Fall back to reading the
  // header directly so emitters that bypass middleware still get a sane value.
  const originActor =
    c.get("originActor") ?? extractOriginActor(c.req.raw) ?? UNKNOWN_ORIGIN_ACTOR;

  const origin = requiredOriginInfo(c.req.raw);
  const clientDistinctId = extractAgentRelayDistinctId(c.req.raw);
  // Caller-declared user/org. Analytics dimensions only — never authorization.
  const actor = extractActorIdentity(c.req.raw);
  c.get("engine").telemetry.capture({
    name: event,
    // Prefer the caller's user id: it puts these server events on the same
    // PostHog person as that user's CLI/broker events. `client_distinct_id` is
    // already the user id when the CLI is signed in; the explicit fallback
    // chain also covers callers that send only one of the two headers.
    distinctId: actor.actor_user_id ?? clientDistinctId ?? workspaceId,
    properties: {
      app: "relaycast-server",
      surface: "cloud",
      workspace_id: workspaceId,
      ...(clientDistinctId ? { client_distinct_id: clientDistinctId } : {}),
      is_authenticated: Boolean(actor.actor_user_id),
      ...actor,
      origin_actor: originActor,
      origin_client: origin.origin_client,
      origin_version: origin.origin_version,
      ...normalizedProperties,
    },
  });
}
