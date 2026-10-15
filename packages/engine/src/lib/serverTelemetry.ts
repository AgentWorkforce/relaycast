import type { Context } from "hono";
import {
  type ServerTelemetryEventName,
  type ServerTelemetryRequiredProperty,
  type TelemetrySenderProperties,
  type TelemetrySenderType,
} from "@relaycast/types";
import { eq } from "drizzle-orm";
import { workspaces, type agents } from "../db/schema.js";
import type { AppEnv } from "../env.js";
import type { EngineDb } from "../ports/index.js";
import {
  extractActorIdentity,
  extractAgentRelayDistinctId,
  extractOriginActor,
  requiredOriginInfo,
  UNKNOWN_ORIGIN_ACTOR,
} from "./origin.js";

/**
 * Properties for a server event. The hosted sink validates events with
 * `parseInternalTelemetryEvent`, which drops any event missing a required
 * property (or whose name is not in `SERVER_TELEMETRY_EVENTS`), so both are
 * enforced here at compile time. `workspace_id` always comes from the
 * `workspaceId` argument. Required values must not be `undefined`, which the
 * sanitizer strips.
 */
type ServerEventProperties<E extends ServerTelemetryEventName> = Record<
  string,
  unknown
> & {
  [K in Exclude<ServerTelemetryRequiredProperty<E>, "workspace_id">]:
    | string
    | number
    | boolean
    | null;
};

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

/** The agent row fields that attribute an event to a sender and a person. */
export type TelemetryActor = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "type" | "metadata"
> & Partial<Pick<typeof agents.$inferSelect, "tokenHash" | "workspaceId">>;

export type TelemetryWorkspace = Pick<
  typeof workspaces.$inferSelect,
  "id" | "metadata"
>;

/**
 * Overrides for who an event is attributed to. Both default to the request's
 * authenticated agent and workspace; routes pass them when the actor is not
 * the token holder (a node token posting as `from`) or the context has no
 * workspace row.
 */
export interface ServerEventAttribution {
  actor?: TelemetryActor;
  workspace?: TelemetryWorkspace;
}

/**
 * Load the workspace fields that carry its PostHog groups, for emitters that
 * run without an authenticated workspace in context (external webhooks, node
 * sockets). Groups are optional, so a failed lookup yields none rather than
 * dropping the event.
 */
export async function loadTelemetryWorkspace(
  db: EngineDb,
  workspaceId: string,
): Promise<TelemetryWorkspace | undefined> {
  try {
    const [workspace] = await db
      .select({ id: workspaces.id, metadata: workspaces.metadata })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return workspace;
  } catch (error) {
    console.warn('[telemetry] workspace lookup failed; event sent without groups', {
      workspace_id: workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const SEND_EVENTS: ReadonlySet<ServerTelemetryEventName> = new Set([
  'relaycast_server_message_created', 'relaycast_server_thread_reply_created',
  'relaycast_server_dm_sent', 'relaycast_server_group_dm_message_sent',
]);

/** Distinct id for events with no verified person. */
export function workspaceTelemetryDistinctId(workspaceId: string): string {
  return `relaycast-ws:${workspaceId}`;
}

function senderType(type: string): TelemetrySenderType {
  if (type === "human") return "human";
  if (type === "system") return "system";
  return "agent";
}

function senderProperties(actor: TelemetryActor): TelemetrySenderProperties {
  return { sender_type: senderType(actor.type), agent_id: actor.id, agent_name: actor.name };
}

/**
 * Emit a server-side product-telemetry event through the injected
 * {@link TelemetrySink}. Self-host's default sink is a no-op; cloud injects
 * PostHog. The sink owns batching/background-flush, so this returns immediately.
 *
 * Public metadata and headers are correlation hints. The host can resolve a
 * person only from the protected actor context and its own ownership binding.
 */
export function emitServerEvent<E extends ServerTelemetryEventName>(
  c: Context<AppEnv>,
  workspaceId: string,
  event: E,
  properties: ServerEventProperties<E>,
  attribution: ServerEventAttribution = {},
): void {
  const normalizedProperties: Record<string, unknown> = { ...properties };
  // The `workspaceId` argument is authoritative; a caller value must not
  // replace it.
  delete normalizedProperties.workspace_id;
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

  // Context rows belong to the authenticated token; an event about another
  // workspace (e.g. one just created) must not inherit them.
  const contextAgent = c.get("agent");
  const actingAgent =
    attribution.actor ??
    (contextAgent?.workspaceId === workspaceId ? contextAgent : undefined);


  const sender = actingAgent ? senderProperties(actingAgent) : undefined;
  // Do not derive a person or group from editable metadata or raw headers.
  // The host verifies this actor's immutable credential generation separately.
  const scopedActor = actingAgent && (!actingAgent.workspaceId || actingAgent.workspaceId === workspaceId)
    ? actingAgent : undefined;

  c.get("engine").telemetry.capture({
    name: event,
    distinctId: workspaceTelemetryDistinctId(workspaceId),
    processPersonProfile: false,
    ...(scopedActor && scopedActor.type !== 'system' && SEND_EVENTS.has(event) ? {
      setOnce: scopedActor.type === 'human'
        ? { first_human_message_at: new Date().toISOString() }
        : { first_agent_message_at: new Date().toISOString() },
    } : {}),
    actor: {
      workspaceId,
      ...(scopedActor ? {
        agentId: scopedActor.id,
        credentialHash: scopedActor.tokenHash,
        senderType: senderType(scopedActor.type),
      } : {}),
    },
    properties: {
      app: "relaycast-server",
      surface: "cloud",
      // Early, so the sink's 64-property cap can never truncate it away.
      workspace_id: workspaceId,
      ...(clientDistinctId ? { client_distinct_id: clientDistinctId } : {}),
      ...actor,
      ...sender,
      origin_actor: originActor,
      origin_client: origin.origin_client,
      origin_version: origin.origin_version,
      ...normalizedProperties,
      analytics_contract_version: 2,
      emitter: 'relaycast-engine',
      identity_source: 'unverified',
      actor_kind: scopedActor?.type === 'system' ? 'service' : sender?.sender_type ?? 'service',
      is_authenticated: false,
    },
  });
}
