# Spec: RelayFile WorkspaceDO — Plane Separation for Load & Memory Resilience

Tracking: cloud#1215. Companions: #1214 (snapshot bake), #1203 (scheduled-agent delivery), #640 (fsnotify-loop saturation postmortem), #469 (GA scaling).

## Problem

The RelayFile `WorkspaceDO` (`packages/relayfile/src/durable-objects/workspace.ts`, ~1500 lines) is **one Durable Object instance per workspace** — a single-threaded request queue with a **~128MB isolate cap** (stated in `packages/relayfile/test/workspace-do-oom.test.ts:29`). It sits on the critical path of (a) sandbox VFS mount sync, (b) Nango webhook ingestion, (c) writeback delivery. Under concurrent load it hits two failure modes, and because every flow routes through it, **agent I/O fails silently** when it does:

1. **Request-queue saturation** → `http 500 internal_error: Durable Object is overloaded. Requests queued for too long.` (including the WebSocket sync upgrade, which then returns 500 instead of 101).
2. **Isolate memory-limit exceeded** → `Durable Object's isolate exceeded its memory limit and was reset.` (drops in-flight work, surfaces as 502).

**Evidence** (live sandbox `github-email-digest-test-2284ea4a`, ws `50587328`):
```
websocket unavailable; using polling sync: failed to WebSocket dial: expected handshake response status code 101 but got 500
mount sync cycle failed: http 500 internal_error: Durable Object is overloaded. Requests queued for too long.
Sync interval 1s +/- 20%      # ← falls back to 1s polling when the WS upgrade 500s
```
Plus #1203: `/cloud/api/v1/webhooks/nango` → repeated 502 + `Durable Object's isolate exceeded its memory limit and was reset`. And #640: a single client's 1s fsnotify-driven loop saturated capacity for 6.5h — the same amplifier.

### What is already mitigated (do NOT re-spec)
The DO has been hardened incrementally; these are done and this spec builds on them:
- **Writes don't OOM** — `putObjectStream` (`handlers/fs.ts`) consumes the body as a `ReadableStream`, *"never materialized in the DO heap"*, with Content-Length guards returning 413.
- **Webhook ingestion is decoupled** — `storeEnvelopeAndQueue` (`handlers/sync.ts`) writes a light envelope row + `ENVELOPE_QUEUE.send()` and returns 202; the heavy `applyEnvelope` runs in the queue consumer.
- **Digest refresh is alarm-deferred** (not inline on the sync path), per #846.
- **Export is streamed/paginated**; **stats writes swallow "DO overloaded"** so they can't roll back the rev counter; **WebSockets are hibernatable**.

### What remains (the scope of this spec)
1. **Read-path content buffering.** `loadContent` (`workspace.ts:963`) does `object.arrayBuffer()` → `bytesToBase64`, fully materializing each file in the isolate (+33%). Hit by digest rendering (the alarm does multi-window per-event R2 reads), `buildLinearFlatIndexRows` (up to 1000 files), and `/fs/file`. The one OOM vector the write-side fix never reached.
2. **Request-queue saturation.** One DO serializes *everything*: every sandbox's `/fs/tree`, `/fs/events`, `/fs/file` polls, WS upgrades, queue-consumer applies, alarm refreshes. The WS-500 is not a bug (`handlers/websocket.ts` is clean and hibernatable) — it's the DO being overloaded *at upgrade time*, which drops the daemon to 1s polling, which hammers the already-overloaded DO. A positive feedback loop.

## Goals / Non-goals

**Goals**
- No `overloaded`-500 or isolate-reset under representative concurrent load (N sandboxes syncing + a webhook burst + large-file reads).
- File content **never passes through the DO isolate**.
- Sync is **push-first**; polling is a rare, cheap, bounded fallback that cannot saturate the DO.
- Saturation degrades **gracefully** (429 + Retry-After), not into 500/524.
- Per-DO **observability** so saturation is visible before it cascades.

**Non-goals**
- **Sharding the writer DO.** Rejected as the structural direction — see below.
- Changing VFS semantics, the R2 content-addressing layout, or the event/rev consistency model.

### Why not shard the writer DO
The DO is the right tool for what genuinely needs serialization: ordered writes, a transactional SQLite metadata store, one append-only event log, a monotonic rev counter, and the `ON CONFLICT(path)` monotonic guards (`handlers/sync.ts` `applyEnvelope`). Sharding by subtree/path-hash would shatter all of those (global rev counter, single ordered event log, cross-tree digest aggregation, export) and require a coordinator + data migration. The robust move is the opposite: **shrink the DO to only write/coordination work and move everything heavy off it**, so one isolate per workspace is comfortably sufficient. Sharding then becomes a last resort this design should make unnecessary.

## Solution

Separate the **read plane** and **content plane** from the **write/coordination plane**. The DO remains the single authoritative writer per workspace but stops serving bytes and stops being polled directly.

```
WRITE / COORDINATION PLANE (stays in the DO, single per workspace)
  webhook envelope ──► ENVELOPE_QUEUE ──► applyEnvelope ──► SQLite(files/events/rev) ──► broadcast + publish cursor/etag
  writeback ─────────► (streamed put to R2) ─────────────► SQLite metadata ───────────┘

CONTENT PLANE (off the DO)
  daemon needs file bytes ──► stateless R2-proxy Worker (streams object.body) ──► R2 (content-addressed by hash)
                              (DO never touches the bytes)

READ PLANE (off the DO)
  daemon sync poll ──► cached event-cursor + tree snapshot (KV / R2), conditional GET (If-None-Match)
                       └─ 304 when nothing changed → never reaches the DO

PUSH-FIRST + BACKPRESSURE
  steady state = hibernatable WS push.  WS down → jittered exp-backoff reconnect; polling floor ≥5s + jitter.
  DO saturated → 429 + Retry-After (honored by daemon for both sync polls and content fetches).
```

## Architecture

### 1. Content read plane → R2 direct (cloud)
Content is already content-addressed in R2 (`CONTENT_BUCKET`, keyed by `content_hash`/`contentRef`). The daemon already learns the `contentRef`/hash from the tree/events. Serve content bytes **without the isolate**, via a **stateless R2-proxy Worker** (not the DO):
- The Worker does `env.CONTENT_BUCKET.get(contentRef)` and returns `object.body` as the Response body (`Content-Type: octet-stream`, `X-Relayfile-Encoding`) — a `ReadableStream`, never `arrayBuffer()`/base64 in any isolate. Bytes pass through with zero heap cost.
- **Decision — proxy Worker, not signed R2 URLs.** The proxy reuses the existing relayfile token auth (the daemon already carries `RELAYFILE_TOKEN`), keeps content access inside our control plane (subject to §4 backpressure and §7 metrics), and — because content is immutable per hash — can set long cache headers so CF edge-caches the bytes. Signed URLs would add a second auth scheme, a TTL/expiry + URL-leak surface, and would bypass our 429/observability entirely.
- Authorization: the Worker validates the caller's workspace token and that the `contentRef` belongs to the workspace, then streams.
- Remove the isolate-buffering serve path from `loadContent` (`workspace.ts:963`). Keep R2 writes exactly as-is (the write path in `handlers/fs.ts` already streams).
- Files: `handlers/fs.ts` (`/fs/file` GET → redirect/route to the proxy), `workspace.ts:963` (`loadContent`), new stateless content-proxy Worker + route.

### 2. Metadata read plane → cached cursor + tree snapshot (cloud)
Sync polls (`/fs/events` tail, `/fs/tree`) should hit a cache, not the DO:
- The DO publishes a **single R2 snapshot object per workspace** (tree + event tail) on each committed event batch (it already commits events durably *before* broadcast in `applyEnvelope`). The snapshot object's **ETag *is* the sync cursor**.
- `/fs/events` / `/fs/tree` are served from that snapshot and honor conditional `If-None-Match` → return **304** when unchanged; only a changed ETag falls through to a real read.
- **Decision — R2 snapshot, not KV.** KV's 25MB value cap can't hold large trees, and KV's eventual-consistency propagation (up to ~60s) is disqualifying for a sync cursor that must reflect a just-committed event. R2 gives strong read-after-write in-region and native conditional-GET/304, and the DO already writes R2 (`CONTENT_BUCKET`) — same primitive, one snapshot object whose ETag the daemon polls.
- Files: `handlers/fs.ts` (tree/events handlers), `workspace.ts` (publish snapshot on commit), R2 snapshot bucket/prefix.

### 3. Push-first sync + bounded fallback (daemon — cross-repo)
The 1s-poll storm is partly daemon behavior (`internal/mountsync/syncer.go`, separate relayfile-mount repo). Companion PR there:
- Hibernatable WS is the steady state. On WS failure, reconnect with **jittered exponential backoff** (base ~1s → cap ~60s).
- **Polling floor** — never faster than ~5s, always jittered. Poll the cached cursor with `If-None-Match` so a "nothing changed" poll is a 304 that never reaches the DO.
- Honor `Retry-After` (see §4).
- Files (daemon repo): `internal/mountsync/syncer.go` (the "Sync interval 1s" loop), WS reconnect logic.

### 4. Backpressure protocol (cloud + daemon)
CF exposes no DO queue depth, so saturation is detected from signals the DO owns:
- The DO keeps an in-memory **`inflight` counter** (increment at request entry, decrement at exit) and the **timestamp of the oldest in-flight request**. When `inflight` exceeds a configured ceiling **or** the oldest in-flight age exceeds a soft budget (≪ the proxy's ~120s hard limit), new requests are admitted with an immediate **429 + Retry-After** instead of queuing into a 500/524.
- A coarse **router-level concurrency cap** (`packages/relayfile/src/worker.ts` / `app.ts` / middleware) sits in front as a second layer, and any CF "Durable Object overloaded" throw is **translated to 429 at the boundary** (the existing catch path used for stats writes) rather than surfacing as 500.
- Daemon honors `Retry-After` for both sync polls and content fetches.
- Files: `workspace.ts` (inflight/age counters + admission gate), relayfile worker router/middleware, daemon HTTP client.

### 5. Digest rendering off the DO (cloud)
The alarm's multi-window per-event R2 reads are the last write-side OOM vector. Move rendering into a dedicated worker/queue (mirror the `async-nango-sync-worker` pattern): it reads R2, renders digests, and writes them back as normal VFS files via the existing streamed write path. The DO only schedules/enqueues.
- Files: `workspace.ts` `scheduleDigestRefresh` (`:344`) / `runDueDigestRefresh` (`:384`), new digest worker + queue.

### 6. Stream the remaining in-DO readers (cloud)
For readers that must stay in the DO, stream one body at a time with bounded concurrency and a size ceiling — mirror the export-path invariants already asserted in `workspace-do-oom.test.ts:153-283`. Prefer moving `buildLinearFlatIndexRows` (`handlers/sync.ts`, up to 1000 `loadContent` calls) off the DO too (it's aggregation, same shape as digests).

### 7. Observability / SLOs (cloud)
Emit per-DO metrics: inflight/queue depth, isolate memory headroom, 429 rate, WS-connected-vs-polling ratio, content-served-from-R2-vs-DO. Alert before saturation cascades (today it failed silently — `agentworkforce deployments logs` was empty).

## Working agreement (for implementers)

- Work in a **dedicated git worktree off `origin/main`** (`git worktree add <path> -b <branch> origin/main`) — never edit the shared checkout's `main` in place.
- **One PR per phase.** At the end of each phase, **open a pull request** for review (`gh pr create`); do not push to `main` directly.
- A PR isn't done until **CI is green** and review comments (cubic/devin/human) are addressed.
- **Serialize merges** — a cloud `main` push triggers a locked prod SST deploy; merge one PR at a time and wait for the deploy before the next.
- Companion daemon changes live in the **relayfile-mount repo** — open a separate PR there, cross-referenced from the cloud PR.

## Rollout / migration

Phased, each shippable independently (cloud `main` push = prod SST deploy behind a lock — **serialize merges**):

- **Phase 1 — stop the bleeding** (unblocks #1203 fastest): §6 stream `loadContent` for in-DO readers + §4 429 backpressure + §3 daemon jittered backoff / polling floor (kills the 1s-poll loop). Low risk, no protocol change.
- **Phase 2 — content read plane → R2 direct** (§1). Biggest memory + load win.
- **Phase 3 — metadata cache + cursor/etag** (§2). Removes poll load from the DO entirely.
- **Phase 4 — digest worker off the DO** (§5). Removes the last write-side OOM vector.
- **Phase 5 — observability/SLOs** (§7).

**Backward compatibility:** keep the existing base64-JSON content read path until the daemon negotiates R2-direct via a capability header — no flag-day. **No data migration** — the R2 content-addressed layout is unchanged.

## Testing
- New load harness: N concurrent sandboxes syncing + a webhook burst + large-file reads. Assert: no `overloaded`-500 / isolate-reset; WS stays connected (no 1s-poll fallback); content reads do **not** grow peak isolate memory with file size; saturation yields 429+Retry-After, not 500/524.
- Extend `workspace-do-oom.test.ts` memory-shaped invariants to the read/content path.
- Daemon (cross-repo): unit-test backoff/jitter + 304 conditional polling + Retry-After honoring.

## Risks / tradeoffs
- Signed-URL auth surface + TTL (mitigate: short TTL, scope to workspaceId+contentRef).
- Cache staleness vs consistency — bounded by the monotonic cursor/etag the DO publishes on commit.
- Cross-repo coordination with the daemon (capability negotiation gates the cutover).
- 304/etag correctness is load-bearing for the read plane — needs careful tests.
