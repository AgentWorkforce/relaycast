# Relaycast #315: read-only roster status filtering

The baseline already removed roster/detail sweeps in commit `86ef7e5`. This task restored SQL status pushdown while retaining read-time presence and separate maintenance. A bounded or debounced read-path sweep would still write on reads; a new scheduler is unnecessary for presence correctness.

SQL includes fresh stored `active`/`online` rows for active queries and stale ones alongside stored `offline` rows for offline queries. Filtering and serialization share a timestamp. Numeric seconds preserve the strict five-minute boundary without Drizzle Date truncation.

Regression red: 24 failed, 10 passed because filtered requests materialized all 16 roster rows. Final validation: 827 engine tests across 71 files passed, including read-only SQLite list/detail requests, persisted-state snapshots, SQL result counts, workspace isolation, aliases, future timestamps, and exact/fractional TTL boundaries. Engine typecheck, lint, OpenAPI YAML parsing, and whitespace checks passed.

This does not diagnose the reported production overload or change deployment state.
