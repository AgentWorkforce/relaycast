# Agent Continuity Spec

Automatic agent state preservation across release/respawn cycles via relaycast.

## Problem

When agents are released or disconnected, all working context is lost. Re-spawned agents start from scratch with no knowledge of what the previous agent accomplished. The legacy outbox-based continuity protocol is no longer functional.

## Solution: Automatic Continuity via Relaycast

Relaycast already persists all agent messages. On agent disconnect/release, it automatically creates a continuity snapshot from existing data — zero agent-side changes needed.

### Continuity Snapshot

```json
{
  "agent": "Worker1",
  "workspaceId": "ws_xxx",
  "originalTask": "Fix the login bug in src/auth.ts",
  "lastMessages": [
    {"from": "Worker1", "to": "Lead", "body": "DONE: Fixed token validation, added tests", "timestamp": "..."},
    {"from": "Worker1", "to": "Lead", "body": "Found the issue - token expiry not checked", "timestamp": "..."},
    {"from": "Worker1", "to": "Lead", "body": "ACK: Starting on login bug fix", "timestamp": "..."}
  ],
  "messageCount": 47,
  "firstSeen": "2026-02-20T10:00:00Z",
  "lastSeen": "2026-02-20T13:45:00Z",
  "releaseReason": "released via cli",
  "durationMs": 13500000
}
```

Fields:
- **originalTask** — Task description from the spawn request
- **lastMessages** — Last 10 messages sent BY the agent (most recent first)
- **messageCount** — Total messages sent during the session
- **Timestamps** — First seen, last seen, duration
- **releaseReason** — Why the agent was released (if available)

### API Endpoints

**Get continuity:**
```
GET /api/v1/agents/:name/continuity?workspace_id=ws_xxx
```

Response:
```json
{
  "snapshots": [
    {
      "agent": "Worker1",
      "originalTask": "...",
      "lastMessages": [...],
      "capturedAt": "2026-02-20T13:45:00Z",
      "sessionDuration": "3h 45m"
    }
  ]
}
```

**Clear continuity (fresh start):**
```
DELETE /api/v1/agents/:name/continuity?workspace_id=ws_xxx
```

### Broker Integration

Relaycast always captures continuity snapshots on disconnect (Phase 1). Injection into new agents is opt-in.

On agent spawn with `--continue`:

1. Broker queries relaycast: `GET /agents/:name/continuity`
2. If snapshot exists, inject into agent's system prompt:

```
## Previous Session Context
You are continuing work that a previous agent with your name started.

**Original task:** Fix the login bug in src/auth.ts

**Last activity (most recent first):**
- "DONE: Fixed token validation, added tests"
- "Found the issue - token expiry not checked"
- "ACK: Starting on login bug fix"

**Session duration:** 3h 45m (47 messages exchanged)

Review this context and continue where the previous agent left off.
```

3. Agent picks up context naturally — no special protocol needed.

On agent spawn with `--continue-from <agent-name>`:

1. Broker queries relaycast for a different agent's continuity
2. Useful for knowledge transfer — new worker inherits context from predecessor with a different name

Without `--continue`, agents start fresh (default behavior).

### Use Cases

1. **Agent release + re-spawn** — Agent is released, new agent spawned with same name picks up context with `--continue`
2. **Agent crash recovery** — Agent process dies unexpectedly, broker auto-restarts with continuity injected via `--continue`
3. **Session handoff** — End of day, new session next morning continues where previous left off via `--continue`
4. **Model switching** — Agent switched from sonnet to opus mid-task, continuity preserves context across the switch via `--continue`
5. **Scaling** — Agent released due to resource limits, re-spawned when capacity available via `--continue`
6. **Cross-machine continuity** — With cloud link, an agent released on one machine can be continued on another. Requires cloud-synced continuity snapshots via relaycast cloud.
7. **Team knowledge transfer** — A Lead agent spawns a replacement worker and passes `--continue` to give them the previous worker's context. Also supports task-based lookup: `--continue-from <agent-name>` to inherit continuity from a differently-named agent.

### Database Schema

```sql
CREATE TABLE agent_continuity (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  original_task TEXT,
  last_messages JSONB,
  message_count INTEGER DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  release_reason TEXT,
  duration_ms BIGINT,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_continuity_lookup 
  ON agent_continuity(workspace_id, agent_name, captured_at DESC);
```

Retention: Keep last 5 snapshots per agent name per workspace. Auto-prune older ones.

### MCP Tool (Optional Enhancement)

```
relay_checkpoint(summary: string)
```

Agents can explicitly save a checkpoint summary, enriching auto-captured data. Optional — system works without it.

### What This Does NOT Do

- Does NOT persist file changes or git state (agents should commit)
- Does NOT transfer running processes or connections
- Does NOT guarantee identical behavior across respawns
- Does NOT require changes to agent profiles or snippets

## Implementation Phases

### Phase 1: Capture (1-2 days)
- Add `agent_continuity` table to relaycast schema
- On agent disconnect event, create snapshot from message history
- Add GET/DELETE API endpoints

### Phase 2: Inject (1 day)
- Broker queries relaycast on spawn
- Format and inject continuity into agent system prompt
- Add `--continue` flag to spawn to opt into injection

### Phase 3: MCP Tool (0.5 day)
- Add `relay_checkpoint` MCP tool
- Store user-provided summaries alongside auto-captured data

## Success Criteria

- Continuity capture is automatic, injection is opt-in via `--continue`
- Re-spawned agents with `--continue` reference previous work in their first message
- No changes needed to agent profiles or snippets
- Works for all CLI types (claude, codex, gemini, etc.)
