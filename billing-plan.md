# Billing & Workspace Lifecycle Plan

## Overview

Add organizations, billing (Stripe + external), workspace TTL, and email-based signup to RelayCast. Free workspaces require no signup. Paid workspaces require an org with verified email and active payment.

---

## Data Model

### New: `organizations` table

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | Snowflake ID |
| name | text | Org display name |
| email | text | Signup email (unique, nullable for shadow orgs) |
| email_verified | integer | 0/1 boolean |
| password_hash | text | Argon2 hash (nullable for shadow orgs) |
| plan | text | `'free'` or `'pro'` |
| billing_source | text | `'stripe'`, `'external'`, or `null` |
| stripe_customer_id | text | Nullable |
| subscription_status | text | `'active'`, `'past_due'`, `'canceled'`, or `null` |
| org_api_key_hash | text | SHA256 hash of `rk_org_*` key (nullable for shadow orgs) |
| created_at | integer | Unix timestamp |

### Modified: `workspaces` table

| Change | Column | Notes |
|--------|--------|-------|
| ADD | organization_id | FK → organizations.id, NOT NULL |
| ADD | last_activity_at | Unix timestamp, updated on messages/events |
| ADD | deleted_at | Nullable, set on soft-delete |
| DROP | plan | Inherited from org |

### New: `sessions` table (web auth)

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | Random token |
| organization_id | text FK | |
| expires_at | integer | Unix timestamp |
| created_at | integer | |

### New: `email_verifications` table

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| email | text | |
| code | text | 6-digit code |
| organization_id | text FK | |
| expires_at | integer | 15 min TTL |
| created_at | integer | |

---

## API Endpoints

### Org Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /orgs | None | Sign up: email + password + name → creates org, sends verification email, returns org API key |
| POST | /orgs/verify | None | Verify email with code |
| POST | /orgs/login | None | Email + password → sets session cookie + returns org API key |
| POST | /orgs/logout | Session cookie | Clears session |
| GET | /org | Org key or session | Get current org details |
| PATCH | /org | Org key or session | Update org name |
| POST | /org/claim | Org key or session | Attach free workspace to org (body: `{ workspace_api_key }`) |
| POST | /org/workspaces | Org key or session | Create workspace under this org |
| GET | /org/workspaces | Org key or session | List org's workspaces |

### Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /org/billing/checkout | Org key or session | Create Stripe Checkout session → return URL |
| POST | /org/billing/portal | Org key or session | Create Stripe Customer Portal session → return URL |
| GET | /org/billing | Org key or session | Get billing status (plan, subscription_status, current_period_end) |
| POST | /webhooks/stripe | Stripe signature | Handle Stripe events |

### Admin (shared secret)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PUT | /admin/orgs/:id/plan | `X-Admin-Secret` header | Set plan + billing_source for external billing |

### Existing (unchanged behavior)

`POST /workspaces` stays unauthenticated. Internally it now creates a shadow org (`email: null`, `plan: 'free'`) and links the workspace to it.

---

## Auth Model

Three auth mechanisms, checked in order:

1. **Workspace API key** (`Authorization: Bearer rk_live_*`) — scoped to one workspace, used by agents. Same as today.
2. **Org API key** (`Authorization: Bearer rk_org_*`) — scoped to org, used for management. Only works after email verification.
3. **Session cookie** (`relaycast_session`) — set by `/orgs/login`, used by the web UI. HttpOnly, Secure, SameSite=Lax.

Org-level endpoints accept either org key or session cookie.

---

## Stripe Integration

### Checkout Flow

1. User hits "Upgrade" in web UI → `POST /org/billing/checkout`
2. Server creates Stripe Checkout Session with `client_reference_id: org.id`
3. Redirects to Stripe Checkout
4. On success, Stripe sends `checkout.session.completed` webhook
5. Server sets `plan: 'pro'`, `billing_source: 'stripe'`, `subscription_status: 'active'`, stores `stripe_customer_id`

### Webhook Events

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Set pro + active |
| `invoice.paid` | Set active (renewal confirmation) |
| `invoice.payment_failed` | Set past_due |
| `customer.subscription.deleted` | Set plan: free, status: canceled |

### External Billing

External service calls `PUT /admin/orgs/:id/plan` with:
```json
{ "plan": "pro", "billing_source": "external" }
```
To downgrade: `{ "plan": "free" }`. No Stripe involvement.

---

## Workspace TTL & Cleanup

### Rules

| Org Plan | Message Retention | Workspace Lifetime |
|----------|-------------------|-------------------|
| free | Rolling 30 days | 60 days after last activity (30 normal + 30 grace) |
| pro | Unlimited | Never expires |

### `last_activity_at` Updates

Updated on: message send, reaction add, file upload, agent connect. Use KV write-coalescing to avoid a D1 write per event — batch update every 5 minutes per workspace.

### Scheduled Worker (Cron Trigger, daily)

```
1. For each free-plan org:
   a. DELETE messages WHERE created_at < now() - 30 days
   b. For workspaces WHERE last_activity_at < now() - 60 days AND deleted_at IS NULL:
      - SET deleted_at = now() (soft delete)
   c. For workspaces WHERE deleted_at < now() - 30 days:
      - Hard delete workspace + all related data
2. Clean up expired sessions and email verification codes
```

Soft-deleted workspaces return `410 Gone` on API requests. The workspace API key still resolves (for error messaging) but all operations are blocked.

---

## Email (Resend)

- Verification emails on signup (6-digit code, 15-min expiry)
- Workspace expiration warnings (7 days before soft-delete)
- Payment failure notifications

Environment binding: `RESEND_API_KEY` secret in wrangler.toml.

---

## Web UI (site/)

Add to the existing static site at relaycast.dev:

| Page | Path | Description |
|------|------|-------------|
| Sign Up | /signup | Email + password + org name form |
| Verify | /verify | Enter 6-digit code |
| Login | /login | Email + password |
| Dashboard | /dashboard | Org overview: workspaces, plan, usage |
| Billing | /dashboard/billing | Current plan, upgrade button, Stripe portal link |
| Workspaces | /dashboard/workspaces | List, create, delete workspaces |

These can be static HTML + JS (same pattern as current site) calling the API with session cookies. No framework needed.

---

## Migration Plan

### D1 Migration SQL

```sql
-- 1. Create organizations table
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  billing_source TEXT,
  stripe_customer_id TEXT,
  subscription_status TEXT,
  org_api_key_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 2. Create sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 3. Create email_verifications table
CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 4. Add columns to workspaces
ALTER TABLE workspaces ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE workspaces ADD COLUMN last_activity_at INTEGER;
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;

-- 5. Backfill: create shadow org per workspace
-- (Run as a script, not raw SQL — needs snowflake ID generation)

-- 6. Make organization_id NOT NULL after backfill
-- (D1 doesn't support ALTER COLUMN, so this is enforced in application code)

-- 7. Drop plan from workspaces
-- (D1 doesn't support DROP COLUMN — leave it, stop reading/writing it)
```

---

## Environment Additions (wrangler.toml)

```toml
# Secrets (set via `wrangler secret put`)
# RESEND_API_KEY
# STRIPE_SECRET_KEY
# STRIPE_WEBHOOK_SECRET
# ADMIN_SECRET

# Cron trigger
[triggers]
crons = ["0 4 * * *"]  # Daily at 4am UTC
```

---

## Implementation Order

1. **Schema migration** — new tables, alter workspaces
2. **Org engine + routes** — CRUD, shadow org creation
3. **Auth middleware** — org key + session cookie support
4. **Email verification** — Resend integration, verify flow
5. **Update `POST /workspaces`** — auto-create shadow org
6. **Claiming** — `POST /org/claim` with workspace key proof
7. **Stripe integration** — checkout, webhooks, portal
8. **Admin endpoint** — external billing support
9. **TTL worker** — cron trigger, message trimming, workspace cleanup
10. **`last_activity_at` tracking** — KV coalescing on hot paths
11. **Web UI** — signup, login, dashboard, billing pages
12. **Update README + openapi.yaml**
