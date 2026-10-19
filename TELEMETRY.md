# Telemetry

Relaycast collects product telemetry to understand feature usage and reliability.
Standalone clients remain anonymous; the hosted service can attribute events to a
Cloud account only through a verified private ownership binding.

## What We Collect

Relaycast sends telemetry to PostHog for:

- Product usage analytics
- Reliability and operational diagnostics

Telemetry payloads can include event names, anonymous identifiers, runtime metadata (for example platform and version), and sanitized properties.

## What We Avoid Collecting

Telemetry is designed to avoid sensitive data:

- Property sanitization removes common secret-like keys (`token`, `api_key`, `secret`, `password`, `authorization`)
- Property keys and values are constrained and normalized
- Events are schema-validated in `@relaycast/types`

## Where Data Is Sent

Telemetry is sent to PostHog.

Standalone MCP default host: `https://i.agentrelay.com`. No API key is baked in;
without a configured key, the MCP sends no telemetry.

Host and authentication can be configured through environment settings.

## How To Disable Telemetry

Set either environment variable:

- `DO_NOT_TRACK=1`
- `RELAYCAST_TELEMETRY_DISABLED=1`

## Identifiers

Standalone MCP telemetry reads legacy identity and consent from `~/.relay/telemetry.json`
and stores new anonymous generations separately in `~/.relay/telemetry-identity.json`
and always sends `$process_person_profile: false`. Caller-supplied distinct IDs,
including `RELAYCAST_TELEMETRY_DISTINCT_ID`, cannot select a Cloud person. Events
include versioned emitter and actor provenance, without email/name writes.

The MCP rereads consent on each capture and suppresses capture when the consent
file is malformed or unreadable. Rotation atomically replaces only the identity
file, never the consent file. Explicit opt-out rotates both anonymous and session
generations; a missing API key alone does not. If saving a rotation fails, the
process keeps using its fresh in-memory identity and retries persistence on later
captures. A process exit before storage becomes writable can lose that rotation;
persistent cross-process rotation cannot be guaranteed while disk writes fail.
An unreadable or incomplete telemetry file is left in place, so a newer opt-out
is not replaced by an older in-memory identity.

### Server identity and ownership

The OSS engine emits typed domain observations through optional `EngineDeps.telemetry`.
The default sink is a no-op. `EngineObservation` is exported from
`@relaycast/engine/ports`: `kind` identifies the lifecycle event (for example
`message.created`), `facts` contains required domain fields, and `workspaceId`
and `occurredAt` identify its scope and occurrence time. `sender` identifies
the domain sender; `authenticatedActor` separately describes the credential
principal with `agentId`, `type`, and an optional SHA-256 `credentialHash`.
This digest fingerprints the credential actually presented, independently of
custom authentication storage. It is private host provenance and must never
reach an analytics transport.

The host maps observations to its event names, identities, groups, eligibility,
and first-use profile properties. The engine has no analytics identity or
person-profile fields. Public identity headers and workspace metadata do not
enter observations. `EngineConfig.logExport(record)` similarly injects a generic
structured log callback; the host owns endpoint, credentials, and transport.
Both observer and log callbacks isolate synchronous throws and rejected promises.

A node can select a `from` sender for a product message. That does not establish
possession of that sender's credential or ownership of their Cloud account.
Public metadata, caller user/distinct-ID headers, and event target IDs cannot
establish analytics ownership.

The hosted sink verifies the protected actor against a private, unexpired Cloud
ownership binding and the current credential generation. Only a matching binding
selects the exact canonical Cloud user ID and its organization/workspace groups.
Unmapped, revoked, expired, or superseded credentials remain personless; product
authentication may still accept an older credential during its grace window.

Human activity remains `actor_kind: human`; an agent acting for an owner remains
`actor_kind: agent`, with separate owner and acting-agent fields. Node/service
activity must not be promoted to a human based on a message's sender or target.

For verified send events, the hosted sink can set `first_human_message_at` or
`first_agent_message_at` once according to the verified actor kind. Cloud owns
email/name profile delivery. The engine does not derive person properties or
Cloud groups from public workspace/agent metadata.

## Best-Effort Delivery

Telemetry delivery is best-effort:

- Request failures are swallowed
- Telemetry does not block normal operation

## Code References

- `packages/types/src/telemetry.ts`
- `packages/mcp/src/telemetry.ts`
- `packages/engine/src/lib/serverTelemetry.ts`
