# Telemetry

Relaycast includes anonymous PostHog telemetry.

## Opt Out

### CLI command

```bash
relaycast telemetry disable
```

To re-enable:

```bash
relaycast telemetry enable
```

Check status:

```bash
relaycast telemetry status
```

### Environment variables

Either of these disables telemetry:

```bash
DO_NOT_TRACK=1
RELAYCAST_TELEMETRY_DISABLED=1
```
