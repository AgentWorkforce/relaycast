# Telemetry

Relaycast collects anonymous product telemetry to understand feature usage and reliability.

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

Default host: `https://us.i.posthog.com`

Host and authentication can be configured through environment settings.

## How To Disable Telemetry

Set either environment variable:

- `DO_NOT_TRACK=1`
- `RELAYCAST_TELEMETRY_DISABLED=1`

## Identifiers

Telemetry uses anonymous identifiers.

## Best-Effort Delivery

Telemetry delivery is best-effort:

- Request failures are swallowed
- Telemetry does not block normal operation

## Code References

- `packages/types/src/telemetry.ts`
- `packages/mcp/src/telemetry.ts`
- `packages/server/src/lib/telemetry.ts`
- `packages/server/src/lib/logger.ts`
