# Agent Continuity Spec

## Problem

When agents are released or disconnected, all their working context is lost. If a new agent is spawned with the same name or similar task, it starts from scratch with no knowledge of what the previous agent accomplished.

## Current State

- Relaycast already persists all agent messages (every send/receive)
- The broker stores the original spawn task for each agent
- Agents emit DONE/ACK protocol messages naturally
- There is a legacy outbox-based continuity protocol that is no longer functional (agents no longer write to outbox files)

## Proposed Solution: Automatic Continuity via Relaycast

### 1. Continuity Snapshot (Relaycast-side)

On agent disconnect or release, relaycast automatically creates a continuity snapshot:

```json
{
  "agent": "Worker1",
  "workspaceId": "ws_xxx",
  "originalTask": "Fix the login bug in src/auth.ts",
  "lastMessages": [
    {"from": "Worker1", "to": "Lead", "body": "ACK: Starting on login bug fix", "timestamp": "..."},
    {"from": "Worker1", "to": "Lead", "body": "Found the issue - token expiry not checked", "timestamp": "..."},
    {"from": "Worker1", "to": "Lead", "body": "DONE: Fixed token validation, added tests", "timestamp": "..."}
  ],
  "messageCount": 47,
  "firstSeen": "2026-02-20T10:00:00Z",
  "lastSeen": "2026-02-20T13:45:00Z",
  "releaseReason": "released via cli",
  "durationMs": 13500000
}
```

The snapshot includes:

- **originalTask**: The task description from the spawn request
- **lastMessages**: Last 10 messages sent BY the agent (not received), most recent first
- **messageCount**: Total messages sent during the session
- **Timestamps**: First seen, last seen, duration
- **releaseReason**: Why the agent was released (if available)

### 2. New Relaycast API Endpoints

```
GET /api/v1/agents/:name/continuity
```

Returns the most recent continuity snapshot for an agent name within a workspace.

Query params:

- `workspace_id` (required)
- `limit` - number of snapshots to return (default: 1, for history)

Response:

```json
{
  "snapshots": [
    {
      "agent": "Worker1",
      "originalTask": "...",
      "lastMessages": ["..."],
      "capturedAt": "2026-02-20T13:45:00Z",
      "sessionDuration": "3h 45m"
    }
  ]
}
```

```
DELETE /api/v1/agents/:name/continuity
```

Clear continuity for an agent (fresh start).

### 3. Broker Integration

When the broker spawns an agent:

1. Check relaycast for existing continuity: `GET /agents/:name/continuity`
2. If a snapshot exists, inject it into the agent's system prompt as context:

```
## Previous Session Context
You are continuing work that a previous agent with your name started.

**Original task:** Fix the login bug in src/auth.ts

**Last activity (most recent first):**
- "DONE: Fixed token validation, added tests"
- "Found the issue - token expiry not checked"
- "ACK: Starting on login bug fix"

**Session duration:** 3h 45m (47 messages exchanged)

Review this context and continue where the previous agent left off, or start fresh if the task has changed.
```

3. The agent naturally picks up context without any special protocol or manual action.

### 4. Storage

Continuity snapshots stored in relaycast's existing database:

```sql
CREATE TABLE agent_continuity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  original_task TEXT,
  last_messages JSONB,
  message_count INTEGER DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  release_reason TEXT,
  duration_ms BIGINT,
  captured_at TIMESTAMPTZ DEFAULT NOW(),

  -- Keep only last 5 snapshots per agent per workspace
  CONSTRAINT unique_agent_workspace UNIQUE (workspace_id, agent_name, captured_at)
);

CREATE INDEX idx_continuity_lookup ON agent_continuity(workspace_id, agent_name, captured_at DESC);
```

Retention: Keep last 5 snapshots per agent name per workspace. Auto-prune older ones.

### 5. MCP Tool (Optional Enhancement)

Add an MCP tool for agents to explicitly save a checkpoint:

```
relay_checkpoint(summary: string)
```

This would add a user-provided summary to the continuity snapshot, enriching the auto-captured data. But this is optional — the system works without it.

### 6. What This Does NOT Do

- Does NOT persist file changes or git state (agents should commit their work)
- Does NOT transfer running processes or connections
- Does NOT guarantee the new agent will behave identically
- Does NOT require any changes to agent profiles or CLAUDE.md snippets

## Implementation Phases

### Phase 1: Capture (1-2 days)

- Add `agent_continuity` table to relaycast schema
- On agent disconnect event, create snapshot from existing message history
- Add GET/DELETE API endpoints

### Phase 2: Inject (1 day)

- Broker queries relaycast on spawn
- Format and inject continuity into agent system prompt
- Add `--fresh` flag to spawn to skip continuity injection

### Phase 3: MCP Tool (optional, 0.5 day)

- Add `relay_checkpoint` MCP tool
- Store user-provided summaries alongside auto-captured data

## Success Criteria

- Agent continuity is fully automatic — zero manual action required
- Re-spawned agents reference previous work in their first message
- No changes needed to any agent profiles or snippets
- Works for all CLI types (claude, codex, gemini, etc.)
