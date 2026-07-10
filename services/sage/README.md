# Sage Service

This directory is the operational wrapper for the Sage deployment that is owned
by SST in [infra/sage.ts](/Users/khaliqgant/Projects/AgentWorkforce/cloud/infra/sage.ts).

Sage does not use Docker Compose, Kubernetes, Fly.io, or Railway in this repo.
The cloud repo deploys Sage to AWS ECS through SST, with DNS managed by
Cloudflare.

## Files

- `.env.example`: stage-specific deployment inputs for Sage.
- `load-secrets.sh`: loads Sage config into SST secrets for the selected stage.
- `deploy.sh`: wraps the standard cloud repo deploy, dev, remove, and local Docker flows.

## Runtime Configuration

`load-secrets.sh` writes these values into SST-managed secrets before deployment:

| Runtime env | SST secret |
| --- | --- |
| `OPENROUTER_API_KEY` | `SageOpenrouterApiKey` |
| `SUPERMEMORY_API_KEY` | `SageSupermemoryApiKey` |
| `NANGO_SECRET_KEY` | `SageNangoSecretKey` |
| `CLOUD_API_TOKEN` | `SageCloudApiToken` |

`CLOUD_API_TOKEN` is the bearer token Sage uses to call the cloud web app's
`/api/v1/workspaces/:workspaceId/integrations/:provider` endpoint so it can
resolve Nango connection IDs per workspace at runtime.

Non-secret configuration (`CLOUD_API_URL`, `SAGE_WORKSPACE_ID`) is inlined in
[`infra/sage.ts`](/Users/khaliqgant/Projects/AgentWorkforce/cloud/infra/sage.ts)
as stage-derived values. `CLOUD_API_URL` is sourced from `infra/web-routing.ts`
so Sage always points at the same origin as the cloud web app for the current
stage.

The deployed service injects these runtime variables:

- `OPENROUTER_API_KEY`
- `SUPERMEMORY_API_KEY`
- `NANGO_SECRET_KEY`
- `CLOUD_API_URL`
- `CLOUD_API_TOKEN`
- `SAGE_WORKSPACE_ID`
- `PORT=3777`

Per-workspace Slack and GitHub connection IDs are resolved dynamically via the
cloud web app. The `NANGO_SLACK_CONNECTION_ID` / `NANGO_GITHUB_CONNECTION_ID`
fallbacks in Sage's `.env.example` are only used for local single-tenant dev
(no `CLOUD_API_URL` / `CLOUD_API_TOKEN`) and are not injected into the deployed
Worker.

## Deploy

1. Copy `.env.example` to `.env`.
2. Fill in the required secrets and stage values.
3. Run:

```bash
./services/sage/deploy.sh deploy
```

This will:

1. Validate AWS access for the selected `AWS_PROFILE`.
2. Load Sage secrets into SST for the selected `SST_STAGE`.
3. Run the standard cloud repo deploy: `npm run deploy -- --stage "$SST_STAGE"`.

### Other Commands

Start SST dev mode:

```bash
./services/sage/deploy.sh dev
```

Remove the stage:

```bash
./services/sage/deploy.sh remove
```

Run the Sage container locally with Docker:

```bash
./services/sage/deploy.sh local
```

That local flow runs the same root image build used by ECS:

```bash
docker build -t sage ../sage
docker run -p 3777:3777 --env-file ../sage/.env sage
```

## Health Check

Sage exposes:

- `GET /health`

The ECS service and the container health check both use:

```bash
curl -fsS http://localhost:3777/health
```

## Domains

- Production: `https://sage.agentrelay.com`
- Non-production: `https://<stage-domain>.sage.agentrelay.com`

The exact non-production hostname is derived by SST from the stage family and
stage name.

## Slack / Nango Webhook Update

After the first deploy, update the Slack Event Subscriptions Request URL from
your local ngrok URL to the deployed Sage URL:

```text
https://<deployed-domain>/api/webhooks/slack
```

Examples:

- `https://sage.agentrelay.com/api/webhooks/slack`
- `https://staging.sage.agentrelay.com/api/webhooks/slack`

Update this in the Slack app at:

- Slack App Settings
- Event Subscriptions
- Request URL
