# local

`local` is a Rust binary that runs a local Relaycast-compatible API + WebSocket daemon.

By default, Relaycast SDKs connect to the hosted Relaycast API + WebSocket service (Cloudflare-hosted).
`local` is for local/offline workflows where you want the same interfaces while keeping traffic and state on your machine.

## Install (prebuilt, no Cargo required)

From release assets (`local-v*` tags):

```bash
curl -fsSL https://github.com/AgentWorkforce/relaycast/releases/download/local-v0.1.0/local-darwin-arm64 -o local
chmod +x local
sudo mv local /usr/local/bin/local
```

Supported release asset names:

- `local-darwin-arm64`
- `local-darwin-x64`
- `local-linux-x64`
- `local-windows-x64.exe`

## Build (maintainers)

Build an artifact for the current host:

```bash
bash packages/local/scripts/build-local-artifact.sh
```

Windows PowerShell:

```powershell
pwsh ./packages/local/scripts/build-local-artifact.ps1
```

Raw Cargo build:

```bash
cargo build --release --manifest-path packages/local/Cargo.toml
```

Binary path:

```bash
packages/local/target/release/local
```

## Run

```bash
cargo run --manifest-path packages/local/Cargo.toml -- --host 127.0.0.1 --port 7528
```

## SDK Local Mode

Hosted Relaycast is the default target.
SDK local mode switches clients to this daemon for local-first workflows with most core features.

SDKs can run local mode directly:

- TypeScript: `new RelayCast({ apiKey: "rk_live_...", connection: { local: true } })`
- Python: `Relay(api_key="rk_live_...", local=True)`
- Rust: `RelayCast::new(RelayCastOptions::local("rk_live_..."))`

In local mode, SDKs auto-start the daemon and require an `api_key` just like hosted mode.
TypeScript uses the binary bundled in the npm package `bin/` directory (or `RELAYCAST_LOCAL_BIN` override).

## Implemented interface surface

This binary implements the core Relaycast REST + WS surface used by broker and SDK workflows, including:

- Workspace bootstrap: `POST /v1/workspaces`
- Agent lifecycle: register/list/get/update/delete, rotate token, spawn/release, presence, heartbeat/disconnect
- Channels: create/list/get/archive, topic updates, join/leave/invite, members/read-status
- Messages: post/list/get, thread replies, reactions, read receipts
- DMs: direct + group flows, conversations, messages, participant management
- Utility endpoints: inbox, search, activity, workspace stats
- Files, webhooks, and subscriptions APIs used by SDKs
- Commands: register/list/delete/invoke
- Realtime events over `/v1/ws` (`subscribe`/`unsubscribe`/`ping` + Relaycast event types)

## Notes

- State is persisted to a local SQLite snapshot (`--db-path`, default `.agent-relay/state.db`).
- Response envelope and JSON field casing match Relaycast conventions (`snake_case`, `{ ok: true, data }` / `{ ok: false, error }`).
- Intended as a local-compatible daemon; it is not a full Cloudflare Durable Objects replacement.
