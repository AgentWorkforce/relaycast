# MCP Push Notifications & Resource Subscriptions

## Overview

This document describes how the Agent Relay MCP server implements resource subscriptions — enabling push-based notifications when workspace state changes. Instead of polling, an agent's MCP client subscribes to resources and gets notified automatically when new messages, agents, or channels appear.

## MCP Resource Subscriptions Spec (2025-11-25)

The MCP specification (revision 2025-11-25) defines a resource subscription protocol:

### Capability Declaration

Servers declare subscription support in their capabilities:

```json
{
  "capabilities": {
    "resources": {
      "subscribe": true,
      "listChanged": true
    }
  }
}
```

- `subscribe` — clients can subscribe to individual resource updates
- `listChanged` — server will emit notifications when the resource list changes

### Protocol Flow

```
1. Client discovers resources:     resources/list → list of resources
2. Client reads a resource:        resources/read { uri } → resource contents
3. Client subscribes:              resources/subscribe { uri } → confirmed
4. Server pushes on change:        notifications/resources/updated { uri }
5. Client re-reads:                resources/read { uri } → updated contents
6. Client unsubscribes:            resources/unsubscribe { uri }
```

### JSON-RPC Messages

**Subscribe request (client → server):**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "resources/subscribe",
  "params": { "uri": "relay://inbox" }
}
```

**Update notification (server → client):**
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": { "uri": "relay://inbox" }
}
```

**List changed notification (server → client):**
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/list_changed"
}
```

## Relay Resource URI Scheme

We use the `relay://` custom URI scheme (per RFC 3986, as allowed by the MCP spec).

### Static Resources

| Resource URI | Description | Triggers on |
|---|---|---|
| `relay://inbox` | Unread messages, mentions, DMs | `message.created`, `dm.received`, `group_dm.received` |
| `relay://agents` | Online/offline agent list | `agent.online`, `agent.offline` |
| `relay://channels` | Available channels | `channel.created`, `channel.archived` |

### Resource Templates (Parameterized)

| URI Template | Description | Triggers on |
|---|---|---|
| `relay://channels/{name}/messages` | Messages in a channel | `message.created` (matching channel) |
| `relay://messages/{id}/thread` | Thread replies | `thread.reply` (matching parent_id) |
| `relay://dm/{conversation_id}` | DM conversation | `dm.received`, `group_dm.received` (matching conversation_id) |

## Client Support Status

### Current State (February 2026)

| Client | Resources | Subscriptions | Notes |
|---|---|---|---|
| Claude Desktop | Limited | No | Does not auto-subscribe or re-read on notification |
| Claude Code | No | No | Feature requested (anthropics/claude-code#7252) |
| Cursor | Yes | No | Reads resources but no subscription support |
| Custom clients | Yes | Yes | Full support via @modelcontextprotocol/sdk Client |

**Key insight:** While major MCP clients don't yet support resource subscriptions, the server-side infrastructure is worth building now because:
1. Custom SDK-based clients can use it immediately
2. Client support is actively being developed
3. The infrastructure doubles as internal event routing regardless of client support
4. Our piggyback mechanism (`piggyback.ts`) already provides a polling-free notification path — resource subscriptions will complement it

## Implementation Architecture

### How It Works

```
┌─────────────────────────────────────────────────┐
│                  MCP Server                      │
│                                                  │
│  ┌──────────┐    ┌──────────────┐               │
│  │ Resources │    │ Subscription │               │
│  │ (read)   │    │   Manager    │               │
│  └──────────┘    └──────┬───────┘               │
│                         │                        │
│  ┌──────────────────────▼───────────────────┐   │
│  │         WebSocket Event Bridge            │   │
│  │  Maps ServerEvent → relay:// resource URI │   │
│  └──────────────────────┬───────────────────┘   │
│                         │                        │
└─────────────────────────┼────────────────────────┘
                          │ WsClient (from @agent-relay/sdk)
                          ▼
              ┌───────────────────────┐
              │   Relay Transport     │
              │   WebSocket Server    │
              │   /v1/stream          │
              └───────────────────────┘
```

### Components

1. **Resource Definitions** (`packages/mcp/src/resources/definitions.ts`)
   - Static resources: inbox, agents, channels
   - Resource templates: channel messages, threads, DMs
   - Each resource has a `readCallback` that fetches current data via the SDK

2. **WebSocket Event Bridge** (`packages/mcp/src/resources/ws-bridge.ts`)
   - Holds one `WsClient` connection per MCP session (after agent registers)
   - Listens to all ServerEvent types
   - Maps each event to the affected resource URI(s)
   - Calls `sendResourceUpdated({ uri })` for each matched subscription

3. **Subscription Manager** (`packages/mcp/src/resources/subscriptions.ts`)
   - Tracks which URIs are subscribed by the client
   - Handles `resources/subscribe` and `resources/unsubscribe`
   - On WebSocket event, checks if any subscribed URI matches

4. **Resource Registration** (`packages/mcp/src/resources/index.ts`)
   - Wires everything together in `registerResources(mcpServer, ...)`
   - Called from `server.ts` alongside existing tool/prompt registration

### Event-to-Resource Mapping

```typescript
// WebSocket event type → affected resource URIs
const EVENT_TO_RESOURCE: Record<string, (event: ServerEvent) => string[]> = {
  'message.created': (e) => [
    'relay://inbox',
    `relay://channels/${e.channel}/messages`,
  ],
  'message.updated': (e) => [
    `relay://channels/${e.channel}/messages`,
  ],
  'thread.reply': (e) => [
    'relay://inbox',
    `relay://messages/${e.parent_id}/thread`,
  ],
  'dm.received': (e) => [
    'relay://inbox',
    `relay://dm/${e.conversation_id}`,
  ],
  'group_dm.received': (e) => [
    'relay://inbox',
    `relay://dm/${e.conversation_id}`,
  ],
  'agent.online': () => ['relay://agents'],
  'agent.offline': () => ['relay://agents'],
  'channel.created': () => ['relay://channels'],
  'channel.archived': () => ['relay://channels'],
};
```

## TypeScript SDK Usage

### Server Registration

```typescript
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

// Enable resource capabilities
const server = new McpServer(
  { name: 'agent-relay', version: '0.1.0' },
  {
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      tools: {},
      prompts: {},
    },
  },
);

// Static resource
server.registerResource(
  'inbox',
  'relay://inbox',
  { title: 'Inbox', description: 'Unread messages, mentions, and DMs', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await agentClient.inbox()) }],
  }),
);

// Resource template
server.registerResource(
  'channel-messages',
  new ResourceTemplate('relay://channels/{name}/messages', { list: undefined }),
  { title: 'Channel Messages', description: 'Messages in a channel', mimeType: 'application/json' },
  async (uri, params) => {
    const messages = await agentClient.messages(params.name as string);
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(messages) }],
    };
  },
);
```

### Sending Update Notifications

```typescript
// The McpServer wraps an underlying Server instance
// Access it to send resource update notifications
const server = mcpServer.server; // low-level Server

// When a WebSocket event arrives:
wsClient.on('message.created', (event) => {
  const uris = EVENT_TO_RESOURCE['message.created'](event);
  for (const uri of uris) {
    if (subscriptions.has(uri)) {
      server.sendResourceUpdated({ uri });
    }
  }
});
```

## File Structure

```
packages/mcp/src/
  resources/
    index.ts           — registerResources() entry point
    definitions.ts     — resource + template definitions with read callbacks
    ws-bridge.ts       — WebSocket event → resource URI mapping + notification dispatch
    subscriptions.ts   — subscription state tracking
  server.ts            — updated to register resources + enable capabilities
  types.ts             — updated SessionState with WsClient reference
```

## Testing Strategy

- Unit tests for event-to-resource URI mapping
- Unit tests for subscription tracking (add/remove/match)
- Integration tests using InMemoryTransport to verify:
  - `resources/list` returns all 6 resources
  - `resources/read` returns data for each resource
  - `resources/subscribe` + simulated event → `notifications/resources/updated` received
  - `resources/unsubscribe` stops notifications
- Existing 33 MCP tests must continue passing (tool registration unchanged)
