# Trajectory: Update Relaycast PostHog dashboard for product usage and workspace activity metrics

> **Status:** ✅ Completed
> **Confidence:** 84%
> **Started:** February 19, 2026 at 09:52 PM
> **Completed:** February 19, 2026 at 10:00 PM

---

## Summary

Updated Relaycast Overview dashboard with weekly usage pulse, weekly active message senders, total workspace creation count, and average workspace message-active lifespan insights; added all to dashboard and updated dashboard description.

**Approach:** Standard approach

---

## Key Decisions

### Use relaycast_message_sent weekly_active as WA sender proxy
- **Chose:** Use relaycast_message_sent weekly_active as WA sender proxy
- **Reasoning:** Current telemetry does not include a universal per-message agent_id across channel/thread/DM events; this gives a stable weekly distinct sender signal today.

### Use server-side workspace/message events with HogQL for workspace KPIs
- **Chose:** Use server-side workspace/message events with HogQL for workspace KPIs
- **Reasoning:** Total workspace creation and workspace message-active lifespan require workspace-scoped aggregation not expressible as plain trends.

---

## Chapters

### 1. Work
*Agent: default*

- Use relaycast_message_sent weekly_active as WA sender proxy: Use relaycast_message_sent weekly_active as WA sender proxy
- Use server-side workspace/message events with HogQL for workspace KPIs: Use server-side workspace/message events with HogQL for workspace KPIs
