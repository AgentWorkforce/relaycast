# SDK Setup Client — Acceptance Contract

**Source spec:** `docs/sdk-setup-client.md`
**Owner:** `lead-acceptance-contract`
**Status:** Locked — workers must implement against this contract, not the source spec, for any item where the two disagree.

---

## 1. Spec contradictions resolved

These are deviations from `docs/sdk-setup-client.md`. Workers implement the resolution, not the original wording.

| # | Spec text | Resolution |
|---|---|---|
| C1 | "`@relay/sdk` communicate module wraps Relaycast" / `relay.ts ← Simple Relay class (moved/adapted from communicate)` | **No prior `communicate` module exists.** `Relay` in `src/index.ts:2` is currently an alias for `RelayCast`. Build `communicate/relay.ts` net-new. The legacy `RelayCast as Relay` re-export is **removed** to free the name. |
| C2 | AgentClient and communicate Relay both send messages | `AgentClient` exposes `send(channel, text)`, not `post`. The contract uses `send` for `AgentClient` and `post` for `Relay` (communicate-style wrapper). |
| C3 | `createWorkspace` returns workspace metadata | API success response is enveloped and **snake_case**: `{ ok: true, data: { workspace_id, api_key, created_at } }`. Setup client validates with `CreateWorkspaceResponseSchema` from `@relaycast/types` and camelizes via existing `camelizeKeys` helper. Do not introduce mixed-case fallbacks. |
| C4 | Scope item #4: "Token TTL and auto-refresh logic" | Auto-refresh is **out** (also confirmed by Future Work #1). Tokens are surfaced to the caller; no rotation in setup-client. The `setInterval` rejoin sample stays as documentation only. |
| C5 | `lookupWorkspace(name): Promise<WorkspaceHandle \| null>` AND test bullet "lookupWorkspace() — not found: throws WorkspaceNotFoundError" | Signature wins. Returns `null` on miss. **`WorkspaceNotFoundError` is reserved for `joinWorkspace` against a non-existent workspace** (404 from any subsequent call). Drop the throw-on-miss test bullet for lookup. |
| C6 | `lookupWorkspace` returns a `WorkspaceHandle` | Lookup endpoint `GET /v1/workspaces/by-name/{name}` does **not** return an apiKey, so a full handle cannot be constructed. **Change return type to `Promise<WorkspaceLookup \| null>`** (re-exported from `@relaycast/types`). To get an operational handle, callers chain `joinWorkspace(lookup.id, apiKey)`. Update `index.ts` exports accordingly. |
| C7 | `CreateWorkspaceOptions.defaultAgentName` and `JoinWorkspaceOptions.agentName` | **Removed.** No example uses them. `createWorkspace` does not auto-register an agent — the user calls `registerAgent` explicitly, matching every example in the spec. `JoinWorkspaceOptions` becomes an empty interface placeholder; keep the param for future extension. |
| C8 | `AgentRecord` includes `type` | `CreateAgentResponse` from the server has no `type` field. Contract: `WorkspaceHandle.registerAgent` echoes the request `type` (default `'agent'`) into the returned `AgentRecord`. No server-side change required. |
| C9 | "Use `msw` (or inline `fetch` mocking with `vi.stubGlobal`)" | Use **`vi.stubGlobal('fetch', …)`**. Do not add `msw` as a dependency — existing tests already mock `fetch` directly. |
| C10 | `RelaycastSetupOptions.retry: { maxRetries, baseDelayMs }` | Map to `HttpClient.RetryPolicyInput` as `{ maxRetries, backoffMs: baseDelayMs }`. Defaults from existing `DEFAULT_RETRY_POLICY` apply for `backoffMultiplier`, `jitter`, `retryOn`. Setup-client's own direct `fetch` (workspace endpoints) reuses the same policy. |
| C11 | `X-SDK-Version` "injected at build time" | Read at runtime from `SDK_VERSION` constant (`src/version.ts`). No build-time injection. Same source as existing client. |
| C12 | Spec omits origin headers | All direct `fetch` calls in setup-client emit `X-Relaycast-Origin-Surface/Client/Version` from `SDK_ORIGIN` (`src/origin.ts`). Required for parity with existing static methods. |
| C13 | `createWorkspace` idempotency on existing workspace | Detect by inspecting HTTP status code (200 = existed, 201 = created). Reuse the pattern from `RelayCast.createWorkspaceWithStatus`. Surface as `WorkspaceHandle` either way; no special return shape. |
| C14 | "`registerAgent()` — duplicate name: handles gracefully" test bullet | Replace with: duplicate name surfaces through the existing `RelayCast.agents.register` error path as `RelayError` / `name_conflict` with status 409. For graceful rotation, callers use the existing `RelayCast.registerOrRotate` via `workspace.relayCast()`. |
| C15 | `Relay` constructor exposes `agents` accessor | Spec under-defines `agents`. Drop from v1. `Relay` v1 surface = `send`, `post`, `reply`, `inbox`, `onMessage` only. |
| C16 | `CreateWorkspaceOptions.name` is optional | Current `POST /v1/workspaces` requires a non-empty `name`. `createWorkspace` requires `{ name }` and does not send empty workspace creation bodies. |

---

## 2. Final API surface (locked)

### Files (all NEW)

```
packages/sdk-typescript/src/
├── setup.ts                 (new)  RelaycastSetup, WorkspaceHandle
├── setup-types.ts           (new)  All setup-related interfaces
├── setup-errors.ts          (new)  RelaycastSetupError + subclasses
├── communicate/
│   ├── index.ts             (new)  Re-exports
│   ├── types.ts             (new)  Message, MessageCallback, RelayConfig
│   └── relay.ts             (new)  Relay class wrapping AgentClient
└── index.ts                 (edit) Add new exports; REMOVE `RelayCast as Relay` alias
```

### Type contracts (locked exactly)

**`RelaycastSetupOptions`**
```ts
{
  baseUrl?: string                                 // overrides the hosted default (https://cast.agentrelay.com)
  apiKey?: string | (() => string | Promise<string>)
  requestTimeoutMs?: number                        // default 30_000, applied via AbortSignal.timeout
  retry?: { maxRetries: number; baseDelayMs: number }  // default { 3, 500 }
}
```

**`RelaycastSetup`**
```ts
constructor(options?: RelaycastSetupOptions)
createWorkspace(options: { name: string }): Promise<WorkspaceHandle>
joinWorkspace(workspaceId: string, apiKey: string, options?: {}): Promise<WorkspaceHandle>
lookupWorkspace(name: string): Promise<WorkspaceLookup | null>   // C6
```

**`WorkspaceHandle`**
```ts
readonly info: WorkspaceInfo                       // { workspaceId, apiKey, baseUrl, createdAt?, name? }
readonly workspaceId: string
readonly apiKey: string
relayCast(): RelayCast                             // singleton per handle
as(token: string): AgentClient                     // new instance per call
relay(agentName: string): Relay                    // singleton per agentName; throws AgentNotRegisteredError
registerAgent(opts: RegisterAgentOptions): Promise<AgentRecord>
getAgentToken(name: string): string | undefined
listRegisteredAgents(): AgentRecord[]
getApiKey(): string
```

**`RegisterAgentOptions`** (matches `CreateAgentRequestSchema` from `@relaycast/types`)
```ts
{ name: string; type?: 'agent' | 'human' | 'system'; persona?: string; metadata?: Record<string, unknown> }
```

**`AgentRecord`**
```ts
{ id: string; name: string; type: 'agent' | 'human' | 'system'; token: string; status: 'online' | 'offline' | 'away'; createdAt: string }
```
`type` is filled from the request (default `'agent'`); other fields come from the server response.

**`Relay` (communicate)** — wraps an `AgentClient`
```ts
post(channel: string, text: string): Promise<MessageWithMeta>
send(toAgent: string, text: string): Promise<SendDmResponse>
reply(messageId: string, text: string): Promise<MessageWithMeta>
inbox(): Promise<InboxResponse>
onMessage(cb: MessageCallback): () => void          // calls connect() lazily; returns unsubscribe
```

**`Message`** (communicate-style)
```ts
{ id: string; sender: string; channel?: string; text: string; createdAt: string; threadId?: string | null }
```

### Error classes (locked)

`RelaycastSetupError` (base) → `RelaycastApiError` (`httpStatus`, `httpBody`), `MalformedApiResponseError` (`field`, `response`), `WorkspaceNotFoundError` (`workspaceName`), `AgentNotRegisteredError` (`agentName`), `MissingApiKeyError`. Codes per spec.

### Validation

- Workspace responses validated with `CreateWorkspaceResponseSchema` and `WorkspaceLookupSchema` from `@relaycast/types`. Validation failure ⇒ `MalformedApiResponseError`.
- Agent registration goes through the existing `RelayCast.agents.register` (already validated by the envelope path); no new schema work.
- Direct setup HTTP errors map to `RelaycastApiError(httpStatus, httpBody)`. Agent registration reuses the existing `RelayCast.agents.register` error path, including `RelayError` / `name_conflict` for duplicate names. 401 ⇒ `MissingApiKeyError` only when `apiKey` is empty/missing pre-flight; otherwise stays `RelaycastApiError`.

### HTTP details (locked)

- Direct `fetch` for `POST /v1/workspaces`, `GET /v1/workspaces/by-name/{name}`. Everything else goes through `RelayCast` / `AgentClient` (which already retries + sets headers).
- Headers on direct fetch: `Content-Type` (POST only), `Authorization` (when key present), `X-SDK-Version`, `X-Relaycast-Origin-Surface/Client/Version`.
- Retry: 429 (honor `Retry-After`) and 5xx, exponential backoff with jitter via shared `RetryPolicy`.
- Timeout: `AbortSignal.timeout(requestTimeoutMs)` per attempt.

### Index exports (locked diff)

```ts
// REMOVE
export { RelayCast, RelayCast as Relay } from './relay.js';
export type { RelayCastOptions, RelayCastOptions as RelayOptions, ... } from './relay.js';

// REPLACE WITH
export { RelayCast } from './relay.js';
export type { RelayCastOptions, EnsureWorkspaceResponse } from './relay.js';

// ADD
export { RelaycastSetup, WorkspaceHandle } from './setup.js';
export type {
  RelaycastSetupOptions, CreateWorkspaceOptions, JoinWorkspaceOptions,
  RegisterAgentOptions, AgentRecord, WorkspaceInfo,
} from './setup-types.js';
export {
  RelaycastSetupError, RelaycastApiError, MalformedApiResponseError,
  WorkspaceNotFoundError, AgentNotRegisteredError, MissingApiKeyError,
} from './setup-errors.js';
export { Relay } from './communicate/relay.js';
export type { Message, MessageCallback, RelayConfig } from './communicate/types.js';
export type { WorkspaceLookup } from '@relaycast/types';
```

`RelayOptions` alias is dropped — no callers in-repo.

---

## 3. Paths to be proven by tests

Each bullet is a single test case. **All must pass before this step is COMPLETE.**

### 3a. Unit — `src/__tests__/setup.test.ts`

1. `createWorkspace()` happy path — issues `POST /v1/workspaces` to default base URL, parses snake_case body, returns `WorkspaceHandle` with `info.workspaceId`, `info.apiKey`, `info.createdAt`.
2. `createWorkspace()` 500 — throws `RelaycastApiError` with `httpStatus === 500`.
3. `createWorkspace()` malformed (missing `workspace_id`) — throws `MalformedApiResponseError` with `field === 'workspace_id'`.
4. `createWorkspace()` 200 vs 201 — both return `WorkspaceHandle`; no exception on existed-200.
5. `createWorkspace()` retry — first response 503, second 200 — succeeds; assert two `fetch` calls.
6. `createWorkspace()` honors `Retry-After: 1` on 429.
7. `createWorkspace()` `requestTimeoutMs` — fetch hung, AbortSignal fires, error surfaces.
8. `joinWorkspace()` happy path — does NOT call any endpoint by default; produces handle with provided id+key. (If implementation chooses to ping `/v1/workspace`, that ping must be assert-tested.)
9. `lookupWorkspace()` found — returns `WorkspaceLookup` (id, name, createdAt).
10. `lookupWorkspace()` not found (404) — returns `null` (no throw).
11. `registerAgent()` happy path — calls `POST /v1/agents`, stores `AgentRecord` with caller-supplied `type`.
12. `registerAgent()` duplicate (409) — throws the existing SDK `RelayError` / `name_conflict` with `statusCode === 409`.
13. `relay('Alice')` after registration — returns `Relay` instance; second call returns same instance.
14. `relay('Unknown')` — throws `AgentNotRegisteredError` with `agentName === 'Unknown'`.
15. `as(token)` — returns new `AgentClient`; subsequent `.send` uses bearer `${token}`.
16. `relayCast()` — returns `RelayCast` configured with workspace `apiKey` and `baseUrl`.
17. `getAgentToken('Alice')` after register — returns the stored token; unknown name returns `undefined`.
18. `listRegisteredAgents()` — returns all registered records in registration order.
19. Default base URL — `new RelaycastSetup()` produces `baseUrl === 'https://cast.agentrelay.com'`.
20. Explicit `baseUrl` (e.g. a self-hosted engine) overrides the default.
21. `apiKey` as function — invoked once per request (or memoized; assert behavior the impl chooses) and bearer header reflects the resolved value.
22. Origin headers — every direct fetch carries `X-SDK-Version`, `X-Relaycast-Origin-Surface/Client/Version`.

### 3b. Unit — `src/__tests__/communicate-relay.test.ts`

23. `Relay.post('#general', text)` → `agentClient.send('#general', text)` — single fetch to `/v1/channels/general/messages`.
24. `Relay.send('Bob', text)` → `POST /v1/dm` with `to: 'Bob'`.
25. `Relay.reply(id, text)` → `POST /v1/messages/{id}/replies`.
26. `Relay.inbox()` → `GET /v1/inbox`.
27. `Relay.onMessage(cb)` — calls `connect()` lazily, subscribes, dispatches a synthetic `message.created` to `cb` with `Message` shape; returned function unsubscribes.

### 3c. Local E2E — `packages/sdk-typescript/scripts/e2e-setup-client.ts` (new)

Run against a locally booted engine (`npx @relaycast/engine`, default port 8787). Steps, all asserted:

E1. `setup = new RelaycastSetup({ baseUrl: 'http://localhost:8787' })`.
E2. `ws1 = await setup.createWorkspace({ name: \`e2e-\${Date.now()}\` })` — handle has non-empty `apiKey`.
E3. `ws2 = await setup.joinWorkspace(ws1.workspaceId, ws1.apiKey)` — `ws2.workspaceId === ws1.workspaceId`.
E4. `lookupWorkspace(ws1.info.name!)` returns id matching `ws1.workspaceId`; `lookupWorkspace('does-not-exist')` returns `null`.
E5. `alice = await ws1.registerAgent({ name: 'Alice' })`, `bob = await ws1.registerAgent({ name: 'Bob' })` — both have tokens, distinct ids.
E6. `ws1.as(alice.token).channels.create({ name: 'general' })`; both join.
E7. `ws1.relay('Alice').post('#general', 'hello')` — message visible via `ws1.as(bob.token).messages('#general')`.
E8. `ws1.relay('Bob').inbox()` includes the new message.
E9. `ws1.relay('Bob').onMessage(cb)` — Alice posts again; `cb` fires within 5s with the new text.
E10. Second `createWorkspace` with the same name and `apiKey: ws1.apiKey` returns existed-200 path; same `workspaceId`.
E11. Build green: `cd packages/sdk-typescript && npm run build && npm test`. No regression in existing test files.

E2E lives behind `RELAY_E2E=1` env gate so CI without a local server skips. Lead must confirm green run locally before signing off.

### 3d. Build / typecheck

E12. `npm run build` (or equivalent monorepo build) succeeds — proves all type contracts and that the removed `Relay` alias has no remaining importers.
E13. `npm test` workspace-wide — all existing suites still pass.

---

## 4. File ownership

Single owner per file. Workers MUST coordinate in `#wf-sdk-setup-client` before touching any shared file. Read-only files require no coordination.

| Worker | Owns (write) | Reads (no edits) |
|---|---|---|
| **worker-types-errors** | `setup-types.ts`, `setup-errors.ts` | `packages/types/src/agent.ts`, `packages/types/src/workspace.ts`, `src/types.ts` |
| **worker-setup-core** | `setup.ts` | depends on `setup-types.ts`, `setup-errors.ts`; reads `relay.ts`, `agent.ts`, `client.ts`, `casing.ts`, `origin.ts`, `version.ts` |
| **worker-communicate** | `communicate/relay.ts`, `communicate/types.ts`, `communicate/index.ts` | `agent.ts`, `ws.ts`, `types.ts` |
| **worker-tests-unit** | `__tests__/setup.test.ts`, `__tests__/communicate-relay.test.ts` | all impl files (read only) |
| **worker-e2e** | `scripts/e2e-setup-client.ts`, optional `package.json` script entry (`e2e:setup`) | `packages/engine` (run only, no edits) |
| **lead-acceptance-contract** | `src/index.ts` (final export wiring), `docs/sdk-setup-client-acceptance.md` | n/a |

**Coordination rules:**

- Workers ship in this order to avoid edit conflicts: types-errors → (setup-core ‖ communicate ‖ tests-unit drafted against contract) → lead wires `index.ts` → e2e runs.
- `index.ts` is touched **only by lead** at the end. If a worker thinks they need an export, post in `#wf-sdk-setup-client` and lead adds it.
- If anyone needs a new schema in `@relaycast/types`, they MUST stop and ping `#wf-sdk-setup-client` first — types changes ripple across packages and are out of scope unless the contract requires them.
- Tests author writes against this contract before impl is done; impl authors must keep their public surface matching the test expectations or escalate to lead for a contract amendment.
- Every worker runs `npm run build && npm test` in `packages/sdk-typescript` before declaring done.

---

## 5. Out of scope (do not implement)

Everything in source-spec §"Future Work", plus: token auto-refresh, `defaultAgentName`, `JoinWorkspaceOptions.agentName`, `Relay.agents`, `msw` dependency, build-time `X-SDK-Version` injection, Python SDK changes, server-side changes.
