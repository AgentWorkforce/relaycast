# MCP-Based Delivery Acknowledgment

## Problem

Current delivery ack relies on PTY echo pattern-matching which is brittle with chatty agents.

## Key Assumption

Relaycast MCP is the ONLY way agents communicate. No file-based outbox, no inline `->relay:` protocol.

## Solution

Since all agent communication flows through MCP tools (`relay_send`, `relay_inbox`, etc.), delivery acknowledgment is implicit:

1. Broker injects message into agent's PTY
2. Relaycast records the delivery attempt with a `delivery_id`
3. Agent processes the message
4. Agent responds via `relay_send` MCP tool call
5. Relaycast sees the MCP call and correlates it with the pending delivery
6. Delivery status: `injected → confirmed` (agent called relay_send after injection)

## Delivery State Machine

```
injected → confirmed (agent sent MCP message after injection)
injected → timeout (no MCP activity within threshold)
```

## Correlation Logic

- After injecting a message to agent X, track a pending delivery
- When agent X makes ANY `relay_send` MCP call, mark the most recent pending delivery as confirmed
- If agent X makes no MCP calls within `deliveryTimeoutMs` (default 60s), mark as timeout
- No output pattern matching needed

## API

```
GET /api/v1/deliveries/:id → { status: "injected" | "confirmed" | "timeout", confirmedAt?: string }
```

## WebSocket Event

```json
{"type": "delivery.confirmed", "delivery_id": "...", "agent": "Worker1", "confirmed_at": "..."}
```

## SDK Integration

`sendAndWaitForDelivery()` subscribes to relaycast WebSocket, resolves when `delivery.confirmed` event arrives for the delivery_id.

## What This Replaces

- Echo detection in inject.rs (pattern matching agent output)
- Optimistic delivery assumption in relay-pty
- File-based sidecar ack (never built)
- All output-based ack heuristics

## Implementation

- **Phase 1:** Add delivery tracking table to relaycast (delivery_id, agent, status, timestamps)
- **Phase 2:** Correlate MCP relay_send calls with pending deliveries
- **Phase 3:** WebSocket delivery events + SDK integration

## Estimated Effort

2-3 days
