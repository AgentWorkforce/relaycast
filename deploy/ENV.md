# Relay Transport — Environment Variables

## Required

| Variable | Description | Example |
|----------|-------------|---------|
| DATABASE_URL | PostgreSQL connection string | postgresql://user:pass@host:5432/relay |
| REDIS_URL | Redis connection string | redis://default:pass@host:6379 |

## Optional

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | HTTP server port | 8080 |
| NODE_ENV | Environment mode | production |
| TIGRIS_ENDPOINT | S3-compatible storage endpoint | https://fly.storage.tigris.dev |
| TIGRIS_ACCESS_KEY | Storage access key | (none) |
| TIGRIS_SECRET_KEY | Storage secret key | (none) |
| TIGRIS_BUCKET | Storage bucket name | relay-files |
| STRIPE_SECRET_KEY | Stripe API secret key | (none) |
| STRIPE_WEBHOOK_SECRET | Stripe webhook signing secret | (none) |
| FLY_MACHINE_ID | Fly.io machine ID (auto-set) | (auto) |

## Fly.io Secrets

Set these as Fly.io secrets (not in fly.toml):

```bash
fly secrets set DATABASE_URL="postgresql://..."
fly secrets set REDIS_URL="redis://..."
fly secrets set STRIPE_SECRET_KEY="sk_live_..."
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
fly secrets set TIGRIS_ACCESS_KEY="..."
fly secrets set TIGRIS_SECRET_KEY="..."
```
