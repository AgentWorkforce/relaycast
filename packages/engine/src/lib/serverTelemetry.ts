import type { Context } from "hono";
import type {
  ServerTelemetryEventName,
  TelemetryGroups,
  TelemetryPersonSetOnce,
  TelemetrySenderProperties,
  TelemetrySenderType,
} from "@relaycast/types";
import type { agents, workspaces } from "../db/schema.js";
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

/** The agent row fields that attribute an event to a sender and a person. */
export type TelemetryActor = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "type" | "metadata"
>;

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

/** Sends whose first occurrence is stamped on the person via `$set_once`. */
const SEND_EVENTS: ReadonlySet<ServerTelemetryEventName> = new Set([
  "relaycast_server_message_created",
  "relaycast_server_thread_reply_created",
  "relaycast_server_dm_sent",
  "relaycast_server_group_dm_message_sent",
]);

const CLOUD_ID_MAX_LENGTH = 128;

/** Distinct id for events with no person; a workspace is never a person. */
export function workspaceTelemetryDistinctId(workspaceId: string): string {
  return `relaycast-ws:${workspaceId}`;
}

function cloudId(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CLOUD_ID_MAX_LENGTH) return undefined;
  return trimmed;
}

function senderType(type: string): TelemetrySenderType {
  if (type === "human") return "human";
  if (type === "system") return "system";
  return "agent";
}

function senderProperties(
  actor: TelemetryActor,
  cloudUserId: string | undefined,
): TelemetrySenderProperties {
  const type = senderType(actor.type);
  return {
    sender_type: type,
    agent_id: actor.id,
    agent_name: actor.name,
    ...(type !== "human" && cloudUserId ? { agent_owner_user_id: cloudUserId } : {}),
  };
}

function workspaceGroups(
  workspace: TelemetryWorkspace | undefined,
): TelemetryGroups | undefined {
  const organization = cloudId(workspace?.metadata, "cloud_org_id");
  const cloudWorkspace = cloudId(workspace?.metadata, "cloud_workspace_id");
  if (!organization && !cloudWorkspace) return undefined;
  return {
    ...(organization ? { organization } : {}),
    ...(cloudWorkspace ? { workspace: cloudWorkspace } : {}),
  };
}

function firstSendSetOnce(
  sender: TelemetrySenderProperties,
): TelemetryPersonSetOnce {
  const now = new Date().toISOString();
  if (sender.sender_type === "human") return { first_human_message_at: now };
  // An agent send counts toward a person only when an owner is known.
  return sender.agent_owner_user_id ? { first_agent_message_at: now } : {};
}

/**
 * Emit a server-side product-telemetry event through the injected
 * {@link TelemetrySink}. Self-host's default sink is a no-op; cloud injects
 * PostHog. The sink owns batching/background-flush, so this returns immediately.
 *
 * The person is the acting agent's `metadata.cloud_user_id` (a human, or the
 * owner of an agent), else the caller-declared user/client id, else the
 * workspace with person processing off. The workspace's cloud org and
 * workspace ids become PostHog groups.
 */
export function emitServerEvent(
  c: Context<AppEnv>,
  workspaceId: string,
  event: ServerEvent,
  properties: Record<string, unknown>,
  attribution: ServerEventAttribution = {},
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

  // Context rows belong to the authenticated token; an event about another
  // workspace (e.g. one just created) must not inherit them.
  const contextAgent = c.get("agent");
  const contextWorkspace = c.get("workspace");
  const actingAgent =
    attribution.actor ??
    (contextAgent?.workspaceId === workspaceId ? contextAgent : undefined);
  const workspace =
    attribution.workspace ??
    (contextWorkspace?.id === workspaceId ? contextWorkspace : undefined);

  const cloudUserId = actingAgent
    ? cloudId(actingAgent.metadata, "cloud_user_id")
    : undefined;
  const sender = actingAgent
    ? senderProperties(actingAgent, cloudUserId)
    : undefined;
  // `client_distinct_id` is already the user id when the CLI is signed in; the
  // explicit user header covers callers that send only one of the two.
  const personId = cloudUserId ?? actor.actor_user_id ?? clientDistinctId;
  const groups = workspaceGroups(workspace);
  const setOnce =
    personId && sender && SEND_EVENTS.has(event as ServerTelemetryEventName)
      ? firstSendSetOnce(sender)
      : {};

  c.get("engine").telemetry.capture({
    name: event,
    distinctId: personId ?? workspaceTelemetryDistinctId(workspaceId),
    ...(personId ? {} : { processPersonProfile: false }),
    ...(groups ? { groups } : {}),
    ...(Object.keys(setOnce).length > 0 ? { setOnce } : {}),
    properties: {
      app: "relaycast-server",
      surface: "cloud",
      workspace_id: workspaceId,
      ...(clientDistinctId ? { client_distinct_id: clientDistinctId } : {}),
      is_authenticated: Boolean(actor.actor_user_id),
      ...actor,
      ...sender,
      origin_actor: originActor,
      origin_client: origin.origin_client,
      origin_version: origin.origin_version,
      ...normalizedProperties,
    },
  });
}
