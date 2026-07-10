# relayfile-cloud

Private Cloudflare Workers server for relayfile.
Implements the same API as the open-source Go server.

## Development

```bash
npm install
npm run dev
npm run -w web db:migrate -- --stage <stage>
npx sst deploy --stage <stage>
```

Run SST from the repository root. `production` uses the root relay domains and every
other stage is deployed the same way under its own SST stage name.

## Contract

The OpenAPI spec lives in the public repo: github.com/AgentWorkforce/relayfile/openapi/
Both servers must pass the same E2E test suite.

## WorkspaceDO memory invariants

Touching `src/durable-objects/**`? Read
[`docs/architecture/workspace-do-invariants.md`](../../docs/architecture/workspace-do-invariants.md)
first. The per-workspace DO has a ~128 MiB cap and a set of
load-bearing invariants (streaming export, streaming writeback, SQL
LIMIT enforcement, admission control, sharding option) that keep it
from OOMing.

Alert thresholds and operator runbooks:
[`docs/operations/relayfile-alerts.md`](../../docs/operations/relayfile-alerts.md).
