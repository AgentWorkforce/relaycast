# V5-02 Sage ↔ Cloud ↔ Slack E2E Spec

## 1. Stack Topology (`docker-compose.e2e.yml`)

### Services

#### postgres

- **Image:** `postgres:16.4-alpine`
- **Healthcheck:** `pg_isready -U e2e -d e2e` (interval 2s, timeout 3s, retries 10)
- **Environment:**
  - `POSTGRES_USER=e2e`
  - `POSTGRES_PASSWORD=e2e-pass`
  - `POSTGRES_DB=e2e`
- **Ports:** `5433:5432` (host 5433 to avoid conflicts with local postgres)
- **Volumes:** none (ephemeral; seeded via `seed.sh` after startup)
- **Networks:** `e2e`

#### mock-slack

- **Image:** `node:20.14-alpine`
- **Working directory:** `/app`
- **Command:** `node server.js`
- **Volumes:** `./docker/e2e/mock-slack:/app:ro`
- **Healthcheck:** `wget -qO- http://localhost:3001/__health || exit 1` (interval 2s, timeout 3s, retries 10)
  - Use `wget` not `curl` — `node:20.14-alpine` ships wget but not curl.
- **Ports:** `13001:3001`
- **Networks:** `e2e`

#### mock-nango

- **Image:** `node:20.14-alpine`
- **Working directory:** `/app`
- **Command:** `node server.js`
- **Volumes:** `./docker/e2e/mock-nango:/app:ro`
- **Environment:**
  - `MOCK_SLACK_URL=http://mock-slack:3001`
  - `SAGE_WEBHOOK_URL=http://miniflare-sage:8787/api/webhooks/slack`
- **Healthcheck:** `wget -qO- http://localhost:3002/__health || exit 1` (interval 2s, timeout 3s, retries 10)
- **Ports:** `13002:3002`
- **depends_on:** mock-slack (`service_healthy`)
- **Networks:** `e2e`

#### cloud-web

- **Build:** `docker/e2e/cloud-web.Dockerfile` (context: `.`, so the full repo is available)
- **Healthcheck:** `wget -qO- http://localhost:3000/api/health || exit 1` (interval 3s, timeout 5s, retries 15, start_period 15s)
- **Ports:** `13000:3000`
- **Environment:**
  - `DATABASE_URL=postgres://e2e:e2e-pass@postgres:5432/e2e`
  - `CLOUD_API_TOKEN=e2e-secret`
  - `NANGO_SECRET_KEY=e2e-nango-key`
  - `NANGO_BASE_URL=http://mock-nango:3002`
  - `NODE_ENV=production`
  - `AUTH_SESSION_SECRET=e2e-session-secret`
  - `CREDENTIAL_ENCRYPTION_KEY=e2e-credential-key-32chars-pad00`
- **depends_on:** postgres (`service_healthy`)
- **Networks:** `e2e`

#### miniflare-sage

- **Build:** `docker/e2e/miniflare-sage.Dockerfile` (context: `..`, so both `cloud/` and `sage/` are accessible)
- **Healthcheck:** `wget -qO- http://localhost:8787/health || exit 1` (interval 3s, timeout 5s, retries 15, start_period 10s)
- **Ports:** `18787:8787`
- **depends_on:** cloud-web (`service_healthy`), mock-slack (`service_healthy`), mock-nango (`service_healthy`)
- **Networks:** `e2e`

### Network

```yaml
networks:
  e2e:
    driver: bridge
```

### Constraints

- NO `:latest` tags anywhere.
- All inter-service ordering uses `depends_on` with `condition: service_healthy`.
- All healthchecks are protocol-level (pg_isready / HTTP GET), never TCP-only.

---

## 2. Dockerfiles

### `docker/e2e/cloud-web.Dockerfile`

Multi-stage build:

```
# Stage 1: install + build
FROM node:20.14-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/ packages/core/
COPY packages/web/ packages/web/
RUN npm ci --workspace=packages/core --workspace=packages/web
RUN npm run build --workspace=packages/core
RUN npm run build --workspace=packages/web

# Stage 2: runtime
FROM node:20.14-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/web ./packages/web
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=packages/web"]
```

Note: The actual Dockerfile must handle Next.js standalone output if the build produces it. Builders should check `packages/web/next.config.*` for `output: "standalone"` and adapt accordingly.

### `docker/e2e/miniflare-sage.Dockerfile`

```
FROM node:20.14-alpine AS builder
WORKDIR /sage
COPY sage/package.json sage/package-lock.json ./
RUN npm ci
RUN npm run build

FROM node:20.14-alpine AS runtime
WORKDIR /app
RUN npm install -g wrangler@3
COPY --from=builder /sage/dist ./dist
COPY --from=builder /sage/package.json ./package.json
COPY docker/e2e/miniflare-sage/wrangler.e2e.toml ./wrangler.toml
EXPOSE 8787
CMD ["wrangler", "dev", "--local", "--port", "8787", "--config", "wrangler.toml"]
```

A `wrangler.e2e.toml` provides bindings matching `infra/sage.ts`:

```toml
name = "sage-e2e"
main = "dist/index.js"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "e2e"
CLOUD_API_URL = "http://cloud-web:3000"
CLOUD_API_TOKEN = "e2e-secret"
OPENROUTER_API_KEY = "e2e-fake"
SUPERMEMORY_API_KEY = "e2e-fake"
NANGO_SECRET_KEY = "e2e-nango-key"
NANGO_SLACK_CONNECTION_ID = "conn-e2e"
SLACK_BOT_USER_ID = "U-BOT"
SAGE_WORKSPACE_ID = "T-E2E"

[[kv_namespaces]]
binding = "DEDUP"
id = "dedup-e2e"

[[kv_namespaces]]
binding = "THREADS"
id = "threads-e2e"
```

---

## 3. Mock Slack (`docker/e2e/mock-slack/server.js`)

Plain Node.js HTTP server, no dependencies. Listens on port 3001.

### State

```js
let recorder = [];          // { method, path, headers, body, ts }
let nextOverride = null;    // { ok: false, error: "rate_limited" } or null
```

### Routes

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/__health` | `200 { ok: true }` |
| `GET` | `/__recorder` | `200 [... recorded requests]` |
| `POST` | `/__reset` | `200 { ok: true }` — clears recorder + nextOverride |
| `POST` | `/__control/ok-false` | `200 { ok: true }` — sets nextOverride to `{ ok: false, error: body.error \|\| "rate_limited" }` |
| `POST` | `/api/chat.postMessage` | See below |
| `POST` | `/api/chat.postEphemeral` | `200 { ok: true }` |
| `POST` | `/api/reactions.add` | `200 { ok: true }` |
| `POST` | `/api/reactions.remove` | `200 { ok: true }` |
| `GET` | `/api/conversations.replies` | `200 { ok: true, messages: [], has_more: false }` |
| `GET` | `/api/conversations.history` | `200 { ok: true, messages: [], has_more: false }` |
| `POST` | `/api/auth.test` | `200 { ok: true, url: "https://e2e.slack.com/", team: "E2E Workspace", team_id: "T-E2E", user: "sage-e2e", user_id: "U-BOT", bot_id: "B-E2E", is_enterprise_install: false }` |

#### `POST /api/chat.postMessage` response

If `nextOverride` is set, return it and clear it. Otherwise:

```json
{
  "ok": true,
  "channel": "<req.body.channel>",
  "ts": "<Date.now() / 1000 as string>",
  "message": {
    "type": "message",
    "subtype": "bot_message",
    "user": "U-BOT",
    "ts": "<same ts>",
    "text": "<req.body.text>",
    "team": "T-E2E",
    "bot_id": "B-E2E",
    "bot_profile": {
      "id": "B-E2E",
      "deleted": false,
      "name": "sage-e2e",
      "updated": 1700000000,
      "app_id": "A-E2E",
      "team_id": "T-E2E"
    }
  }
}
```

**All routes** record every incoming request to the recorder array before processing.

### Body parsing

Parse request body as JSON. For GET routes with query params, parse from URL search params. The server uses `http.createServer` — no frameworks.

---

## 4. Mock Nango (`docker/e2e/mock-nango/server.js`)

Plain Node.js HTTP server, no dependencies. Listens on port 3002.

### State

```js
let recorder = [];  // { method, path, headers, body, ts }
```

### Routes

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/__health` | `200 { ok: true }` |
| `GET` | `/__recorder` | `200 [... recorded requests]` |
| `POST` | `/__reset` | `200 { ok: true }` — clears recorder |
| `GET` | `/connection/:connectionId` | `200 { connection_id: ":connectionId", provider_config_key: "slack-sage", credentials: { type: "OAUTH2", access_token: "xoxb-e2e-token" }, metadata: { team_id: "T-E2E", bot_user_id: "U-BOT", incoming_webhook: { channel: "C-E2E" } } }` |
| `POST` | `/proxy/*` | Proxy to mock-slack (see below) |
| `POST` | `/__inject-webhook` | Inject an app_mention into sage (see below) |

#### `POST /proxy/*` (Nango proxy passthrough)

1. Read `Connection-Id` and `Provider-Config-Key` headers from the request.
2. Extract the Slack API path from the URL (everything after `/proxy`).
3. Forward the request body to `${MOCK_SLACK_URL}/api${slackPath}`.
4. Return mock-slack's response verbatim.
5. Record both the inbound request and the forwarded request.

#### `POST /__inject-webhook`

This is the fixture injection endpoint. It:

1. Accepts a JSON body containing a Slack event payload (the inner event, not the envelope).
2. Wraps it in the Nango forward envelope shape that sage expects:
   ```json
   {
     "type": "forward",
     "from": "slack",
     "payload": {
       "type": "event_callback",
       "team_id": "<from body>",
       "event": "<body.event>",
       "event_id": "<body.event_id || generated>",
       "event_time": "<body.event_time || now>"
     }
   }
   ```
3. POSTs this envelope to `${SAGE_WEBHOOK_URL}` (env var, default `http://miniflare-sage:8787/api/webhooks/slack`).
4. Returns `{ ok: true, sageStatus: <status code from sage> }`.

---

## 5. Bring-up / Teardown Scripts

### `scripts/e2e/up.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Starting E2E stack..."
docker compose -f "$PROJECT_ROOT/docker-compose.e2e.yml" up -d --wait

echo "==> All services healthy."
```

### `scripts/e2e/seed.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:-e2e}"
DB_PASS="${DB_PASS:-e2e-pass}"
DB_NAME="${DB_NAME:-e2e}"

export PGPASSWORD="$DB_PASS"

echo "==> Running Drizzle migrations..."
DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}" \
  node packages/web/scripts/run-drizzle.cjs migrate

echo "==> Seeding E2E workspace..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
-- Canonical E2E workspace
INSERT INTO workspaces (id, organization_id, slug, name, created_at, updated_at)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000000',
  'e2e-workspace',
  'E2E Workspace',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Slack integration pointing at mock-nango's connection
INSERT INTO workspace_integrations (workspace_id, provider, connection_id, provider_config_key, metadata_json, created_at, updated_at)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'slack-sage',
  'conn-e2e',
  'slack-sage',
  '{"slackTeamId":"T-E2E","slackBotUserId":"U-BOT","workspaceName":"E2E Workspace"}',
  NOW(),
  NOW()
)
ON CONFLICT (workspace_id, provider) DO NOTHING;
SQL

echo "==> Seed complete."
```

### `scripts/e2e/down.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Tearing down E2E stack..."
docker compose -f "$PROJECT_ROOT/docker-compose.e2e.yml" down -v

echo "==> Clean."
```

---

## 6. Fixture Driver (`tests/e2e/drive-app-mention-fixture.ts`)

Written in TypeScript, executed via `tsx`.

### Fixture: `tests/e2e/fixtures/app-mention.json`

Production-shaped Slack `app_mention` event body:

```json
{
  "type": "event_callback",
  "team_id": "T-E2E",
  "event_id": "Ev_E2E_001",
  "event_time": 1700000000,
  "event": {
    "type": "app_mention",
    "user": "U-HUMAN",
    "text": "<@U-BOT> hello",
    "ts": "1700000000.000001",
    "channel": "C-E2E",
    "event_ts": "1700000000.000001",
    "team": "T-E2E"
  }
}
```

### Driver steps

```
1. POST /__reset to mock-slack (localhost:13001) and mock-nango (localhost:13002).
2. POST /__inject-webhook on mock-nango with the app-mention fixture.
3. Poll mock-slack /__recorder every 200ms, up to 15 seconds, until a
   chat.postMessage call appears.
4. Collect evidence:
   a. mock-nango /__recorder → all requests sage made to nango (connection lookups, proxy calls)
   b. mock-slack /__recorder → all Slack API calls (reactions.add, chat.postMessage)
   c. postgres audit row → query slack_proxy_audit or inspect cloud-web logs
5. Run golden-path assertions (section 7.a–7.f).
6. Run control case 1: wrong bearer token.
   - POST /__reset to both mocks.
   - Directly POST to cloud-web /api/v1/proxy/slack with Authorization: Bearer wrong-token.
   - Assert 401/403 response with code 'unauthorized' or 'forbidden'.
   - Assert mock-slack recorder is empty (no calls leaked).
7. Run control case 2: Slack ok:false.
   - POST /__reset to both mocks.
   - POST /__control/ok-false to mock-slack with { error: "channel_not_found" }.
   - POST /__inject-webhook on mock-nango with the same fixture.
   - Poll mock-slack /__recorder for the chat.postMessage call.
   - Assert the response from sage (the final chat.postMessage text, or a second
     fallback message) reflects a mapped error, not a raw stack trace.
8. Write JSON evidence to .logs/e2e-<timestamp>.json.
9. Print PASS/FAIL summary to stdout. Exit 0 on all-pass, 1 on any failure.
```

### Evidence JSON schema

```json
{
  "timestamp": "ISO-8601",
  "goldenPath": {
    "pass": true,
    "nangoRecorder": [...],
    "slackRecorder": [...],
    "assertions": {
      "singlePostMessage": { "pass": true, "detail": "..." },
      "correctChannel": { "pass": true },
      "proxyEnvelope": { "pass": true },
      "providerResolution": { "pass": true },
      "noDirectNangoSdk": { "pass": true },
      "auditRow": { "pass": true }
    }
  },
  "controlWrongBearer": {
    "pass": true,
    "httpStatus": 403,
    "slackCallCount": 0
  },
  "controlOkFalse": {
    "pass": true,
    "detail": "..."
  }
}
```

---

## 7. Hard Invariants

Each invariant has a matching assertion in the fixture driver.

| ID | Invariant | How verified |
|----|-----------|-------------|
| **a** | mock-slack received exactly one `chat.postMessage` during the golden run. | `slackRecorder.filter(r => r.path.includes('chat.postMessage')).length === 1` |
| **b** | The `chat.postMessage` body has `channel="C-E2E"` and `text` is a sage-generated response (not the literal `<@U-BOT> hello`). | Check `body.channel === "C-E2E"` and `body.text !== "<@U-BOT> hello"` and `body.text.length > 0`. |
| **c** | The hop FROM sage → cloud-web carried `Authorization: Bearer e2e-secret`. The hop from cloud-web → mock-nango/mock-slack does NOT carry that same bearer (it uses the Nango proxy headers instead). | Inspect mock-nango recorder: the `/proxy/` request should have `Connection-Id` and `Provider-Config-Key` headers, NOT `Authorization: Bearer e2e-secret`. The cloud-web proxy route resolves credentials internally. |
| **d** | Cloud-web resolved `providerConfigKey` and `connectionId` from the workspace_integrations row using the team_id metadata — not from the sage request body. | Verify the mock-nango proxy request has `Connection-Id: conn-e2e` and `Provider-Config-Key: slack-sage` headers (populated by cloud-web from the DB row). |
| **e** | Sage source code contains no direct import of `@nangohq/node` for Slack egress — it goes through the cloud proxy. | `grep -r "@nangohq/node" ../sage/src/integrations/cloud-proxy-provider` should return 0 matches. (Sage's `package.json` may list `@nangohq/node` for non-Slack integrations like GitHub; the assertion is scoped to the cloud-proxy-provider module.) |
| **f** | The audit record in postgres (from `recordSlackProxyCall`) shows `reason='ok'`, `http_status=200`. The audit does NOT store `data.text` (no message content leakage). | Query the audit table/log and verify fields. If audit is in-memory only (not persisted to DB), verify via cloud-web structured logs or a dedicated audit endpoint. |
| **g** | Control: wrong bearer → cloud-web returns HTTP 401 or 403 with `code='unauthorized'` or `code='forbidden'`. mock-slack recorder shows zero calls. | Direct assertion on HTTP response and recorder length. |
| **h** | Control: mock-slack `ok:false` → sage's reply (the second `chat.postMessage` body, which is the fallback error message) contains a user-friendly error string, not a raw exception. | Assert `text` matches one of the known `getUserFacingErrorMessage` outputs (e.g., "I don't have access to that resource"). |

---

## 8. Wave Plan

### Wave A (parallel — after this spec is approved)

Three independent implementation tasks, all can run concurrently:

| Task | Agent | Outputs |
|------|-------|---------|
| **compose-impl** | codex | `docker-compose.e2e.yml`, `docker/e2e/cloud-web.Dockerfile`, `docker/e2e/miniflare-sage/Dockerfile`, `docker/e2e/miniflare-sage/wrangler.e2e.toml`, `docker/e2e/README.md` |
| **mock-slack-impl** | codex | `docker/e2e/mock-slack/server.js` |
| **mock-nango-impl** | codex | `docker/e2e/mock-nango/server.js` |

### Wave B (after ALL of Wave A completes)

| Task | Agent | Outputs |
|------|-------|---------|
| **scripts-impl** | codex | `scripts/e2e/up.sh`, `scripts/e2e/down.sh`, `scripts/e2e/seed.sh`, `tests/e2e/drive-app-mention-fixture.ts`, `tests/e2e/fixtures/app-mention.json` |

### Wave C (sequential, after Wave B)

1. **validate-compose:** `docker compose -f docker-compose.e2e.yml config` — parse + lint the compose file.
2. **bring-up:** `scripts/e2e/up.sh` then `scripts/e2e/seed.sh` — all services healthy + DB seeded.
3. **drive-fixture:** `npx tsx tests/e2e/drive-app-mention-fixture.ts` — golden path + both control cases.
4. **capture-evidence:** `cat .logs/e2e-*.json` — collect and review evidence file.
5. **tear-down:** `scripts/e2e/down.sh` — ALWAYS runs, even if step 3 or 4 fails.

### Wave D (conditional)

If Wave C reveals failures:

1. **e2e-fix:** Diagnose and fix based on evidence.
2. **re-run:** Repeat Wave C steps 2–5 once.
3. **final-review:** Lead reviews evidence, signs off or flags remaining issues.

---

## 9. Port Summary

| Service | Container Port | Host Port |
|---------|---------------|-----------|
| postgres | 5432 | 5433 |
| mock-slack | 3001 | 13001 |
| mock-nango | 3002 | 13002 |
| cloud-web | 3000 | 13000 |
| miniflare-sage | 8787 | 18787 |

## 10. Canonical IDs

| Entity | Value |
|--------|-------|
| Workspace UUID | `a0000000-0000-4000-8000-000000000001` |
| Organization UUID | `a0000000-0000-4000-8000-000000000000` |
| Slack Team ID | `T-E2E` |
| Slack Channel | `C-E2E` |
| Slack Bot User | `U-BOT` |
| Slack Bot ID | `B-E2E` |
| Slack App ID | `A-E2E` |
| Slack Human User | `U-HUMAN` |
| Nango Connection ID | `conn-e2e` |
| Provider Config Key | `slack-sage` |
| Cloud API Token | `e2e-secret` |
| Nango Secret Key | `e2e-nango-key` |

---

SPEC_COMPLETE
