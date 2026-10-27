import type { Context } from "hono";
import type { EngineObservation, EngineObservationKind, EngineObservationFacts } from '../ports/telemetry.js';
import { type agents } from "../db/schema.js";
import type { AppEnv } from "../env.js";
import {
  extractOriginActor,
  requiredOriginInfo,
  UNKNOWN_ORIGIN_ACTOR,
} from "./origin.js";

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

/** Domain sender fields. Metadata never establishes authenticated provenance. */
export type TelemetryActor = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "type"
>;

/** Optional domain sender override; never changes the authenticated principal. */
export interface ServerEventAttribution {
  actor?: TelemetryActor;
}

function senderType(type: string): 'human' | 'agent' | 'system' {
  if (type === "human") return "human";
  if (type === "system") return "system";
  return "agent";
}

export function emitServerEvent<E extends EngineObservationKind>(
  c: Context<AppEnv>,
  workspaceId: string,
  event: E,
  properties: EngineObservationFacts<E>,
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

  // Context rows belong to the authenticated token; an event about another
  // workspace (e.g. one just created) must not inherit them.
  const contextAgent = c.get("agent");
  const actingAgent =
    attribution.actor ??
    (contextAgent?.workspaceId === workspaceId ? contextAgent : undefined);


  const sender = actingAgent ? { id: actingAgent.id, name: actingAgent.name, type: senderType(actingAgent.type) } : undefined;
  // Only the credential-authenticated agent can establish ownership. A node
  // may name any workspace agent as `from`; loading that sender's row proves
  // neither possession of its token nor any external ownership.
  const scopedActor = contextAgent?.workspaceId === workspaceId ? contextAgent : undefined;

  // Neither synchronous throws nor asynchronous rejections may change a domain outcome.
  try {
    const pending = c.get("engine").telemetry.capture({
      kind: event,
      occurredAt: new Date().toISOString(),
      workspaceId,
      ...(scopedActor ? { authenticatedActor: {
        agentId: scopedActor.id,
        credentialHash: c.get('agentCredentialHash'),
        type: senderType(scopedActor.type),
      } } : {}),
      ...(sender ? { sender } : {}),
      origin: { actor: originActor, client: origin.origin_client, version: origin.origin_version },

      facts: normalizedProperties as EngineObservationFacts<E>,
    } as EngineObservation);
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Host observation is best effort.
  }
}
