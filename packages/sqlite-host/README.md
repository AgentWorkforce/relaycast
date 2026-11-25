# @relaycast/sqlite-host (prototype)

This package runs Relaycast workspaces as plain SQLite files, one per workspace, with no actor runtime. Each workspace has a single writer, and every commit is written to S3 (Express) before the call answers. It's built for the durable-actors vs Postgres benchmark (AgentWorkforce/infra `bench/relaycast`). It is not a supported install path.

## Shape

```
client → relaycast actors gateway → router → host (owner) → SQLite file
                                                  └──────→ S3 Express: log/<slot>, base/<slot>
```

- **Gateway: unchanged.** The router speaks the part of the durable-actors control-plane protocol the gateway uses: `invoke`, `find-websocket`, `healthz`, and a WebSocket path for the socket grant. Point the gateway's `DURABLE_ACTORS_CONTROL_PLANE_URL` and `DURABLE_ACTORS_SOCKET_ORIGIN` at the router.
- **Engine: unchanged.** A host runs the engine's actor runtime (`createActorRuntime`) over a better-sqlite3 file. Calls run one at a time per workspace, and each call is one transaction. This is the same contract the `Workspace` actor has.
- **Router.** A workspace belongs to the healthy host with the highest rendezvous hash of (host, workspace). Hosts are health-checked every 500 ms: a host is marked down after 2 failed checks and up again after 3 good ones.

## Durability: RPO 0

- **WAL shipping.** The database runs in WAL mode, with automatic checkpoints and cache spills off. When a call commits, the frames it appended to the WAL become one segment. The host writes that segment to `log/<next slot>` with `If-None-Match: *`, and the call is answered only once that PUT succeeds.
- **Held socket writes.** Socket writes made during the call are held until then. If the PUT fails, they're dropped, so no client sees state that isn't durable.
- **Extra cost per commit.** One S3 Express PUT on the critical path, sized at about the touched pages (about 4 KiB × pages changed). A call that changes nothing writes nothing.
- **Base snapshots.** Every `SQLITE_HOST_BASE_EVERY` commits (default 500), the host checkpoints the WAL, truncates it, and uploads the database file to `base/<slot>`. This happens inline, between calls.
- **Recovery.** A host rebuilds a workspace from the newest base, then applies the page images of every later slot in order. It doesn't need SQLite to read a WAL.
- **Group commit.** There is none, because calls in a workspace are serial. Commits in different workspaces are written in parallel.
- **Async variant.** `SQLITE_HOST_DURABILITY=async` answers after the local commit and ships slots in order behind it. That makes RPO greater than 0: whatever was answered but not yet written is lost with the host. It's labeled separately in bench results.

## Single writer, fencing and failover

- **Fencing is in the log.** Routing doesn't need to be exact. Log slots are create-only, so two hosts that both think they own a workspace can't both write slot N.
- **The loser recovers.** The host that loses a slot evicts its copy: it deletes the file and closes the workspace's sockets with 4012, so clients reconnect. It then reloads from the log and reruns the call once.
- **Fence watch.** Each host checks once a second whether its next slot already exists, meaning someone else has written past it. If so, it evicts its copy, which moves its sockets to the new owner.
- **Failover time.** It's the router's detection time (about 1–1.5 s) plus the reload: one LIST, one base GET, and at most `BASE_EVERY` slot GETs, 32 at a time. Clients reconnect when their socket drops.

Tradeoffs:

- **Stale reads.** A host the router just moved away from can serve reads from its stale copy until its fence watch, or its next write, notices. That's at most about 1 s.
- **No cross-workspace queries.** Each workspace is its own file on whichever host owns it. Anything that spans workspaces, such as admin listings or analytics, has to fan out through the router, or read the log or bases offline. The Postgres arm gets this for free.
- **One writer per workspace.** A hot workspace is bounded by one host's CPU and by one PUT per commit, with no parallelism inside it. That's the same as the actor arms.
- **The log isn't compacted.** Slots before the newest base are never deleted in this prototype, so a long-running install would need a sweeper.
- **No alarm durability.** An alarm lives in the host's memory. A freshly loaded workspace runs maintenance once, and the engine re-arms its alarm from its outstanding work.

## Run

```
relaycast-sqlite-host host     # SQLITE_HOST_NAME, SQLITE_HOST_SOCKET_ORIGIN, SQLITE_HOST_STORE=s3://bucket/prefix,
                               # SQLITE_HOST_GRANT_SECRET, RELAYCAST_PUBLIC_URL, RELAYCAST_FILE_SIGNING_SECRET, AWS_REGION
relaycast-sqlite-host router   # SQLITE_ROUTER_HOSTS=host-0=http://…,host-1=http://…
```

Every call logs `sqlite_host_call` with:
- `queue_wait_ms`
- `execution_ms` (the SQLite transaction)
- `put_ms` (the S3 write)
- `bytes`

The router logs `sqlite_router_forward` with `router_overhead_ms`.
