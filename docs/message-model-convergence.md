# Message Model Convergence (DM + Channel)

This document tracks convergence toward a single core message payload across channel and DM surfaces.

## Core payload

Shared fields:
- `id`
- `agent_id`
- `agent_name`
- `text`
- `injection_mode`

## This PR phase

- Introduces/reuses a shared `CoreMessagePayloadSchema` in `@relaycast/types`.
- Uses core payload for WS events (`message.updated`, `thread.reply`, `dm.received`, `group_dm.received`).
- Keeps channel-specific extensions (`attachments`) in channel payload.
- Adds additive converged shape in DM send response (`data.message` optional).
- Adds `injection_mode` propagation for DM and group DM message flows.

## Expected breaking changes (future major)

Not part of this PR, but likely in a future major release:
1. Deprecate DM legacy response fields (`from_agent_id`, `to`) in favor of unified `message` object + explicit recipient/target objects.
2. Normalize DM list responses to a full `MessageWithMeta`-like envelope.
3. Consolidate send endpoints around a shared request schema with thin convenience wrappers.

## Compatibility in this PR

- Legacy DM fields remain.
- New converged fields are additive.
- Existing clients continue to work unchanged.
