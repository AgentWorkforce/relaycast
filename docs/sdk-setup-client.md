# SDK Setup Client

**Status:** Proposed  
**Affects:** `packages/sdk-typescript`, hosted cloud

---

## Problem

Using Relaycast today requires understanding at least three separate systems before writing a single line of product code: workspace creation (POST /v1/workspaces), agent registration (POST /v1/agents), and token management. None of these steps are exposed through a coherent setup layer — they live as separate static methods on `RelayCast` with no shared state or lifecycle management.

The result is that embedding Relaycast in an agent sandbox requires either:
- Hand-rolling workspace creation, agent registration, and token management with no type safety, or
- Copying setup code from examples that have no official contract.

The existing `RelayCast` class assumes you already have an API key. It does not know how to get one, and it does not track agent tokens for multi-agent workflows.

The `@relay/sdk` communicate module wraps Relaycast for inter-agent messaging, but it also assumes you already have a workspace and API key — it still requires hand-rolled setup code to get to that point.

---

## Goal

A user running an agent in any sandbox environment (Daytona, E2B, Docker, local) should be able to get from zero to a fully-connected Relaycast workspace with registered agents in a few lines of TypeScript, with no browser interaction required, and a single coherent entry point.

```ts
import { RelaycastSetup } from '@relaycast/sdk'

const setup = new RelaycastSetup()

// Create a workspace and get back a ready-to-use handle
const workspace = await setup.createWorkspace({ name: 'my-agent' })

// Register agents and get back their tokens
const alice = await workspace.registerAgent({ name: 'Alice', type: 'agent' })
const bob = await workspace.registerAgent({ name: 'Bob', type: 'agent' })

// Act as each agent using the same workspace handle
const aliceClient = workspace.as(alice.token)
const bobClient = workspace.as(bob.token)

// Send messages
await aliceClient.send('#general', 'Hey team, standup in 5 minutes')
await bobClient.send('#general', 'On my way!')

// Or use the simpler communicate-style interface
const relay = workspace.relay('Alice')
await relay.send('Bob', 'Are you there?')
```

---

## Scope

This spec covers:

1. A new `RelaycastSetup` class added to `@relaycast/sdk` that wraps workspace creation and agent registration
2. A `WorkspaceHandle` class returned from setup that provides workspace state, agent management, and multiple client types
3. Error types and error handling
4. Token handling, with auto-refresh explicitly deferred
5. Support for both the full RelayCast API and the simpler communicate-style interface
6. What is explicitly out of scope

This spec does **not** cover: self-hosted server setup, Python SDK changes, or changes to any existing `RelayCast` or `AgentClient` methods.

---

## Architecture

### Layers

```
┌──────────────────────────────────────────────────────┐
│  User code                                           │
│  new RelaycastSetup() → workspace.registerAgent()    │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  @relaycast/sdk                                     │
│  RelaycastSetup        — workspace + agent creation  │
│  WorkspaceHandle       — workspace state + clients   │
│  RelayCast             — full API (unchanged)        │
│  AgentClient           — agent-level API (unchanged) │
│  Relay (communicate)   — simple messaging API        │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│  Relaycast API  (api.relaycast.dev / localhost:7528) │
│  /v1/workspaces, /v1/agents, /v1/channels, etc.     │
└──────────────────────────────────────────────────────┘
```

### Cloud API base URL

`RelaycastSetup` defaults to `https://api.relaycast.dev`. This is overridable via constructor option for staging/dev environments or local development.

---

## New SDK Exports

### `RelaycastSetup`

The entry point. Stateless — creates workspaces and returns handles.

```ts
export interface RelaycastSetupOptions {
  /**
   * Base URL for the Relaycast API.
   * @default "https://api.relaycast.dev"
   */
  baseUrl?: string

  /**
   * Workspace API key (rk_live_... or rk_test_...).
   * When omitted, workspace creation proceeds anonymously and returns
   * a new API key. Anonymous workspaces are publicly joinable — use
   * only for ephemeral sandboxes.
   */
  apiKey?: string | (() => string | Promise<string>)

  /**
   * Timeout in milliseconds for each HTTP request to the API.
   * @default 30_000
   */
  requestTimeoutMs?: number

  /**
   * Retry configuration for API calls.
   * @default { maxRetries: 3, baseDelayMs: 500 }
   */
  retry?: {
    maxRetries: number
    baseDelayMs: number
  }

  /**
   * Enable local mode, targeting a locally running Relaycast daemon.
   * Automatically sets baseUrl to http://127.0.0.1:7528 if not overridden.
   * @default false
   */
  local?: boolean
}

export class RelaycastSetup {
  constructor(options?: RelaycastSetupOptions)

  /**
   * Create a new workspace and return a WorkspaceHandle.
   * This calls POST /v1/workspaces, then uses the returned apiKey
   * to construct a fully ready handle.
   *
   * If apiKey is provided in options and a workspace with that name
   * already exists, returns the existing workspace (idempotent).
   */
  createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceHandle>

  /**
   * Rejoin an existing workspace. Use this when you already have
   * a workspaceId and apiKey from a previous session.
   */
  joinWorkspace(
    workspaceId: string,
    apiKey: string,
    options?: JoinWorkspaceOptions,
  ): Promise<WorkspaceHandle>

  /**
   * Look up a workspace by name without creating one.
   * Returns null if the workspace does not exist.
   */
  lookupWorkspace(name: string): Promise<WorkspaceLookup | null>
}
```

---

### `CreateWorkspaceOptions`

```ts
export interface CreateWorkspaceOptions {
  /**
   * Human-readable name for the workspace.
   * Required by POST /v1/workspaces.
   */
  name: string
}
```

---

### `JoinWorkspaceOptions`

```ts
export interface JoinWorkspaceOptions {}
```

---

### `WorkspaceHandle`

Returned by `createWorkspace` and `joinWorkspace`. Holds workspace state and exposes all operations.

```ts
export interface WorkspaceInfo {
  workspaceId: string
  apiKey: string
  baseUrl: string
  /** ISO 8601 creation timestamp */
  createdAt?: string
  name?: string
}

export class WorkspaceHandle {
  /** Resolved workspace metadata */
  readonly info: WorkspaceInfo

  /** Shorthand for info.workspaceId */
  readonly workspaceId: string

  /** Shorthand for info.apiKey */
  readonly apiKey: string

  /**
   * Get the full RelayCast client for workspace-level operations.
   * Requires the workspace API key (rk_live_...).
   */
  relayCast(): RelayCast

  /**
   * Get an AgentClient scoped to a specific agent token.
   * The token is managed by the caller; no auto-refresh at this level.
   */
  as(token: string): AgentClient

  /**
   * Get a simple Relay instance for communicate-style messaging.
   * This is a convenience wrapper around AgentClient with a simpler interface
   * (send, post, reply, inbox, onMessage, agents).
   *
   * @param agentName - Name of the registered agent to act as
   */
  relay(agentName: string): Relay

  /**
   * Register a new agent in this workspace and return the agent record.
   * The agent token is stored in the handle's agent registry for relay() access.
   */
  registerAgent(options: RegisterAgentOptions): Promise<AgentRecord>

  /**
   * Get an already-registered agent's token by name.
   * Returns undefined if the agent has not been registered through this handle.
   */
  getAgentToken(name: string): string | undefined

  /**
   * List all agents registered through this handle.
   */
  listRegisteredAgents(): AgentRecord[]

  /**
   * Get the raw workspace API key.
   * Useful for passing to other processes that need workspace-level access.
   */
  getApiKey(): string
}
```

---

### `RegisterAgentOptions`

```ts
export interface RegisterAgentOptions {
  name: string
  type?: 'agent' | 'human' | 'system'
  persona?: string
  metadata?: Record<string, unknown>
}
```

---

### `AgentRecord`

```ts
export interface AgentRecord {
  id: string
  name: string
  type: 'agent' | 'human' | 'system'
  token: string
  status: 'online' | 'offline' | 'away'
  createdAt: string
}
```

---

## Error Types

All errors extend a base `RelaycastSetupError`:

```ts
export class RelaycastSetupError extends Error {
  readonly code: string
}

/**
 * The API returned a non-2xx response.
 * HTTP 4xx and 5xx responses land here.
 */
export class RelaycastApiError extends RelaycastSetupError {
  readonly code = 'api_error'
  readonly httpStatus: number
  readonly httpBody: unknown
}

/**
 * Workspace creation or join succeeded but the response was missing
 * a required field (workspace_id, api_key, etc.).
 * Should not happen in production — indicates an API contract violation.
 */
export class MalformedApiResponseError extends RelaycastSetupError {
  readonly code = 'malformed_api_response'
  readonly field: string
  readonly response: unknown
}

/**
 * lookupWorkspace() found no workspace with the given name.
 */
export class WorkspaceNotFoundError extends RelaycastSetupError {
  readonly code = 'workspace_not_found'
  readonly workspaceName: string
}

/**
 * relay() was called with an agent name that has not been registered
 * through this handle.
 */
export class AgentNotRegisteredError extends RelaycastSetupError {
  readonly code = 'agent_not_registered'
  readonly agentName: string
}

/**
 * The API key is missing or invalid when required.
 */
export class MissingApiKeyError extends RelaycastSetupError {
  readonly code = 'missing_api_key'
}
```

---

## Internal Implementation

### `RelaycastSetup.createWorkspace()`

Sequence:

1. `POST {baseUrl}/v1/workspaces` with body `{ name }`
   — Auth header: `Authorization: Bearer {apiKey}` if provided, else anonymous
   — Returns: `{ ok: true, data: { workspace_id, api_key, created_at } }`

2. Construct and return a `WorkspaceHandle` with:
   - `info`: from step 1
   - `_relayCast`: new `RelayCast({ apiKey, baseUrl })`
   - `_agents`: `Map<string, AgentRecord>` for registered agents

### `WorkspaceHandle.relayCast()`

Returns a singleton `RelayCast` instance constructed with the workspace API key.

### `WorkspaceHandle.as(token)`

Returns a new `AgentClient` instance for the given agent token. Each call creates a new instance.

### `WorkspaceHandle.relay(agentName)`

1. Look up `agentToken` in `_agents` map by agentName
2. If not found, throw `AgentNotRegisteredError`
3. Create an `AgentClient` and wrap it in a `Relay` instance (communicate-style interface)
4. Store the `Relay` instance per agentName (singleton per agent)

### `WorkspaceHandle.registerAgent(options)`

1. Call `relayCast().agents.register(options)` via the internal RelayCast client
2. Store the returned `AgentRecord` in `_agents` map
3. Return the record

### Token management

The workspace API key and agent tokens returned by registration are not automatically refreshed. If a workspace API key expires:
- Workspace-level operations will return 401 and throw `RelaycastApiError`
- The user should create a new workspace or rejoin

For long-running processes that need to maintain agent sessions, the recommended pattern is:

```ts
const workspace = await setup.createWorkspace({ name: 'my-agent' })
const alice = await workspace.registerAgent({ name: 'Alice' })

// For long-running processes, periodically check and re-register if needed
setInterval(async () => {
  try {
    await workspace.relayCast().agents.presence()
  } catch (err) {
    if (err instanceof RelaycastApiError && err.httpStatus === 401) {
      // Token expired, rejoin workspace
      const fresh = await setup.joinWorkspace(workspace.workspaceId, workspace.apiKey)
      // Re-register agents...
    }
  }
}, 60_000)
```

---

## Usage Examples

### Basic setup — create workspace, register agents, send messages

```ts
import { RelaycastSetup } from '@relaycast/sdk'

const setup = new RelaycastSetup()

const workspace = await setup.createWorkspace({ name: 'my-team' })

const alice = await workspace.registerAgent({ name: 'Alice', type: 'agent' })
const bob = await workspace.registerAgent({ name: 'Bob', type: 'agent' })

// Use the full RelayCast API
const aliceClient = workspace.as(alice.token)
await aliceClient.channels.create({ name: 'general', topic: 'Team chat' })
await aliceClient.channels.join('general')
const bobClient = workspace.as(bob.token)
await bobClient.channels.join('general')

await aliceClient.send('#general', 'Hey team!')
```

### Use the communicate-style interface (simpler)

```ts
const workspace = await setup.createWorkspace({ name: 'my-team' })

const alice = await workspace.registerAgent({ name: 'Alice', type: 'agent' })
const bob = await workspace.registerAgent({ name: 'Bob', type: 'agent' })

const aliceRelay = workspace.relay('Alice')
const bobRelay = workspace.relay('Bob')

await aliceRelay.post('#general', 'Standup in 5 minutes')
await bobRelay.send('Alice', 'On my way')

// Or listen for messages
bobRelay.onMessage((msg) => {
  console.log(`${msg.sender}: ${msg.text}`)
})
```

### Rejoin an existing workspace

```ts
const setup = new RelaycastSetup()

// You have workspaceId and apiKey from a previous session
const workspace = await setup.joinWorkspace(
  'workspace-id-here',
  'rk_live_...',
)

// Agents registered in previous sessions are not automatically restored
// You need to re-register or use existing tokens
const alice = await workspace.registerAgent({ name: 'Alice', type: 'agent' })
```

This is also the relaycast-side entry point for a `@relayfile/sdk` `AgentWorkspaceInvite`: pass `invite.workspaceId` and `invite.relaycastApiKey` to `joinWorkspace()`, set `baseUrl` from `invite.relaycastBaseUrl` when present, then claim the invited identity with `workspace.relayCast().agents.registerOrRotate({ name: invite.agentName })`. For the full multi-agent workflow, see [Agent Workspace Golden Path](../../relayfile/docs/agent-workspace-golden-path.md).

### Local development mode

```ts
const setup = new RelaycastSetup({
  local: true,
  // Optionally override the default local URL
  // baseUrl: 'http://127.0.0.1:7528',
})

const workspace = await setup.createWorkspace({ name: 'local-dev' })
const alice = await workspace.registerAgent({ name: 'Alice' })
```

### Staging environment

```ts
const setup = new RelaycastSetup({
  baseUrl: 'https://api.staging.relaycast.dev',
  apiKey: process.env.STAGING_RELAY_API_KEY,
})
const workspace = await setup.createWorkspace({ name: 'staging-test' })
```

### Ephemeral sandbox with persisted workspace ID

```ts
import { writeFileSync, readFileSync, existsSync } from 'node:fs'

const setup = new RelaycastSetup()

const persistedIdPath = '/tmp/.relaycast-workspace-id'
const persistedKeyPath = '/tmp/.relaycast-workspace-key'

let workspaceId: string | undefined
let apiKey: string | undefined

if (existsSync(persistedIdPath)) {
  workspaceId = readFileSync(persistedIdPath, 'utf8').trim()
  apiKey = readFileSync(persistedKeyPath, 'utf8').trim()
}

const workspace = workspaceId && apiKey
  ? await setup.joinWorkspace(workspaceId, apiKey)
  : await setup.createWorkspace({ name: 'ephemeral-agent' })

if (!workspaceId) {
  writeFileSync(persistedIdPath, workspace.workspaceId)
  writeFileSync(persistedKeyPath, workspace.apiKey)
}

const alice = await workspace.registerAgent({ name: 'Alice' })
```

---

## File Location in `@relaycast/sdk`

```
packages/sdk-typescript/src/
├── setup.ts           ← RelaycastSetup, WorkspaceHandle (new)
├── setup-types.ts     ← All setup-related types/interfaces (new)
├── setup-errors.ts    ← RelaycastSetupError and subclasses (new)
├── relay.ts           ← RelayCast (unchanged)
├── agent.ts           ← AgentClient (unchanged)
├── client.ts          ← HttpClient (unchanged)
├── ws.ts              ← WsClient (unchanged)
├── types.ts           ← Shared types (unchanged)
├── communicate/
│   ├── index.ts       ← Relay export (new entry point)
│   ├── types.ts       ← Message, RelayConfig, etc. (new)
│   └── relay.ts       ← Simple Relay class (moved/adapted from communicate)
└── index.ts           ← Add exports from setup.ts, setup-types.ts, setup-errors.ts
```

---

## Exports Added to `index.ts`

```ts
export { RelaycastSetup, WorkspaceHandle } from './setup.js'
export type {
  RelaycastSetupOptions,
  CreateWorkspaceOptions,
  JoinWorkspaceOptions,
  RegisterAgentOptions,
  AgentRecord,
  WorkspaceInfo,
} from './setup-types.js'
export {
  RelaycastSetupError,
  RelaycastApiError,
  MalformedApiResponseError,
  WorkspaceNotFoundError,
  AgentNotRegisteredError,
  MissingApiKeyError,
} from './setup-errors.js'
export { Relay } from './communicate/relay.js'
export type {
  Message,
  MessageCallback,
  RelayConfig,
} from './communicate/types.js'
export type { WorkspaceLookup } from '@relaycast/types'
```

---

## Testing

### Unit tests (`setup.test.ts`)

Use inline `fetch` mocking with `vi.stubGlobal` to mock the API. Test cases:

- `createWorkspace()` — happy path: calls POST workspaces; returns WorkspaceHandle with correct info
- `createWorkspace()` — API 500: throws `RelaycastApiError` with httpStatus 500
- `createWorkspace()` — malformed response (missing `workspace_id`): throws `MalformedApiResponseError`
- `joinWorkspace()` — happy path: uses provided workspaceId and apiKey
- `lookupWorkspace()` — found: returns WorkspaceLookup
- `lookupWorkspace()` — not found: returns `null`
- `registerAgent()` — happy path: calls POST /v1/agents; stores token
- `registerAgent()` — duplicate name: surfaces existing `RelayError` / `name_conflict` with status 409
- `relay()` — registered agent: returns Relay instance
- `relay()` — unregistered agent: throws `AgentNotRegisteredError`
- `as()` — returns AgentClient with correct token
- `relayCast()` — returns RelayCast with workspace API key
- `getAgentToken()` — returns stored token
- `listRegisteredAgents()` — returns all registered agents
- Local mode — sets correct baseUrl

### Integration tests

Not in scope for the initial implementation. The setup client depends on the API which may not be available in all test environments.

---

## HTTP Request Details

All requests from `RelaycastSetup` and `WorkspaceHandle` to the API:

- Use `fetch` (Node.js 18+ native)
- Set `Content-Type: application/json` on POST requests
- Set `Authorization: Bearer {apiKey}` when apiKey is provided
- Set `X-SDK-Version` header (from `package.json` version, injected at build time)
- Apply exponential backoff with jitter on 429 and 5xx responses, up to `retry.maxRetries` attempts
- Honor `Retry-After` header on 429 responses
- Apply `requestTimeoutMs` via `AbortSignal.timeout()`

---

## Future Work

The following are explicitly deferred from this spec:

1. **Agent token auto-refresh** — Detect when an agent token is about to expire and automatically rotate it. Requires the API to support token TTL introspection or proactive rotation notifications.

2. **Workspace join token** — A lightweight token that allows joining a workspace without full API key access, for scenarios where you want to share workspace access with untrusted processes.

3. **Python SDK** — Mirror `RelaycastSetup` as `RelaycastSetup` in `packages/sdk-python`.

4. **Workspace listing** — `RelaycastSetup.listWorkspaces()` to enumerate workspaces the current API key has access to.

5. **Team invite flow** — A flow for inviting humans to a workspace via email, with email verification and role assignment.

6. **MCP server auto-setup** — A method on `WorkspaceHandle` that configures the MCP server with the correct workspace credentials automatically.

7. **Webhook integration setup** — Convenience methods for setting up common webhook integrations (GitHub, Slack, etc.) with sensible defaults.

8. **Workspace teardown** — A `workspace.delete()` method on `WorkspaceHandle` for cleaning up ephemeral workspaces.
