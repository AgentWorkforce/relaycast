# Trajectory: Add PostHog production logging in server with local console logger and version metadata

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 19, 2026 at 09:33 AM
> **Completed:** February 19, 2026 at 09:39 AM

---

## Summary

Added centralized server logging with console output in non-production, PostHog OTLP log export in production, automatic app/sdk version metadata on each log, and integrated logger into worker/fanout/background/workspace-stream/ChannelDO error paths with tests.

**Approach:** Standard approach

---

## Key Decisions

### Implemented a centralized server logger with environment-based sinks
- **Chose:** Implemented a centralized server logger with environment-based sinks
- **Reasoning:** Keeps log formatting/version metadata consistent and enforces console output outside production while routing production logs to PostHog.

### Used PostHog Logs OTLP HTTP endpoint directly from the worker
- **Chose:** Used PostHog Logs OTLP HTTP endpoint directly from the worker
- **Reasoning:** Cloudflare worker runtime can emit small JSON payloads via fetch without adding heavyweight OpenTelemetry runtime dependencies.

---

## Chapters

### 1. Work
*Agent: default*

- Implemented a centralized server logger with environment-based sinks: Implemented a centralized server logger with environment-based sinks
- Used PostHog Logs OTLP HTTP endpoint directly from the worker: Used PostHog Logs OTLP HTTP endpoint directly from the worker
