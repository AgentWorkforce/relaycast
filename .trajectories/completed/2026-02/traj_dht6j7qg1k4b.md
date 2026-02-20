# Trajectory: Fix rate limiter fallback keying, event queue recovery/guard, remove dead cache code

> **Status:** ✅ Completed
> **Task:** claude/optimize-agent-messaging-BoAQ1
> **Confidence:** 90%
> **Started:** February 9, 2026 at 04:38 AM
> **Completed:** February 17, 2026 at 08:40 PM

---

## Summary

Identified dashboard WS visibility issue during e2e: _dashboard_observer joins only existing channels, but channel.created fanout is channel-scoped so observer misses new channels like engineering and thus misses subsequent events.

**Approach:** Standard approach

---

## Key Decisions

### For headless Slack, prefer keeping current custom WebSocket transport unless scale/ops pain justifies AWS IoT migration
- **Chose:** For headless Slack, prefer keeping current custom WebSocket transport unless scale/ops pain justifies AWS IoT migration
- **Reasoning:** Current product needs rich chat semantics and predictable protocol control; IoT adds at-least-once semantics, quotas (per-connection subscriptions, publish rates), and account-shared endpoint complexity. Re-evaluate if concurrent connections/fanout or reliability requirements outgrow current WS ops.

### If greenfield and goal is near-zero uptime ops, choose serverless edge realtime over Fly Machines
- **Chose:** If greenfield and goal is near-zero uptime ops, choose serverless edge realtime over Fly Machines
- **Reasoning:** Fly reduces ops but still runs app machines with restart and health-check responsibilities; true minimal uptime management is better served by managed/serverless realtime (e.g., Durable Objects hibernation or equivalent) plus managed database.

### For edge-first headless Slack architecture, prefer Neon over Aurora initially
- **Chose:** For edge-first headless Slack architecture, prefer Neon over Aurora initially
- **Reasoning:** Neon aligns with edge/serverless access via HTTP/WebSocket driver, built-in pooling, and branching workflow. Aurora is stronger for deep AWS-native enterprise requirements (Global Database, strict VPC/compliance controls) but introduces more operational and integration overhead for this specific product stage.

### Dashboard websocket misses most e2e events because _dashboard_observer never auto-joins channels created after login
- **Chose:** Dashboard websocket misses most e2e events because _dashboard_observer never auto-joins channels created after login
- **Reasoning:** Observer joins existing channels in auth/session routes, but auto-join on channel.created depends on receiving that event. channel.created fanout is channel-scoped to the new channel members, so observer is excluded and misses subsequent channel events (notably e2e engineering channel).

---

## Chapters

### 1. Work
*Agent: default*

- For headless Slack, prefer keeping current custom WebSocket transport unless scale/ops pain justifies AWS IoT migration: For headless Slack, prefer keeping current custom WebSocket transport unless scale/ops pain justifies AWS IoT migration
- If greenfield and goal is near-zero uptime ops, choose serverless edge realtime over Fly Machines: If greenfield and goal is near-zero uptime ops, choose serverless edge realtime over Fly Machines
- For edge-first headless Slack architecture, prefer Neon over Aurora initially: For edge-first headless Slack architecture, prefer Neon over Aurora initially
- Dashboard websocket misses most e2e events because _dashboard_observer never auto-joins channels created after login: Dashboard websocket misses most e2e events because _dashboard_observer never auto-joins channels created after login
