# Compact maintenance migration

`0050_compact_maintenance_indexes.sql` provides the indexes and cursor table
needed by engine 8.5.3, without first allocating all of 0048/0049. It changes
only indexes and adds the cursor table: no history deletion, TTL changes,
foreign-key changes, or removal of uniqueness constraints.

## Upgrade paths

The Node adapter validates `migrations/supersessions.json` before running pending
SQL. It skips unapplied 0048/0049 only when their explicit replacement 0050 is
present. Missing or edited metadata fails closed. Only executed migrations enter
the journal; existing 0048/0049 journal entries remain unchanged.

Fresh, pre-0048, partially upgraded, and fully 0048/0049-upgraded installations
converge to the same schema. Original published SQL files remain byte-identical.
Custom migration runners must implement the same explicit skip policy, or apply
the complete historical chain and accept its higher temporary storage cost.
For Wrangler, archive the superseded files outside its applied directory and
apply 0050; do not fabricate migration-history rows or edit published SQL.

Rollback must retain the new migration planner. An older Node binary (including
8.5.3) will see the intentionally absent 0048/0049 journal entries and execute
their high-storage SQL on startup. Likewise, do not roll back cloud's applied
migration directory. Roll back runtime code only through the compact-aware
deployment path; do not downgrade the migration runner on a compact-only database.

## Index changes

0050 drops these non-unique indexes **before** creating replacements:

| Retired index | Remaining coverage |
| --- | --- |
| `idx_deliveries_message` | Unique `(message_id, agent_id)` prefix covers message lookup/FK probes |
| `idx_read_receipts_message` | Existing composite primary key and named receipt lookup |
| `idx_deliveries_route_node` | No runtime hint or route-ID query requires this legacy workspace-leading index |
| `idx_deliveries_next_attempt` | Predicate-matched global/workspace node retry indexes |
| `idx_deliveries_http_push_due` | Predicate-matched global/workspace node redrive indexes |
| `idx_deliveries_initial_due` | 0049's node-initial indexes; do not allocate the obsolete broad index |

Every runtime-named index remains available, including `idx_deliveries_id_lookup`.
Runtime SQL does not change. Old code's planner choices may differ after these
drops; test rollback code against the compact schema. Do not automatically rebuild
retired indexes on a nearly full database.

## Capacity and rollout

Run the local-only model with
`node scripts/measure-compact-migrations.mjs 100000 0.5 0.5`.
The third argument is the retry fraction within queued rows (default 0.5).
The model verifies both retry indexes contain the requested population and
reports actual integer row counts. It creates synthetic SQLite data, not a
production copy. On September 8, 2026:

| 100k-delivery model | Legacy peak growth | Compact peak growth | Reduction |
| --- | ---: | ---: | ---: |
| 50% active | 29,323,264 bytes | 6,672,384 bytes | 77% |
| 100% active | 36,741,120 bytes | 15,659,008 bytes | 57% |

The two original cases above have **no retry rows**. Review-expanded scenarios:

| Active / retry fraction | Legacy peak growth | Compact peak growth | Reduction |
| --- | ---: | ---: | ---: |
| 50% active / 50% retry | 28,037,120 bytes | 6,664,192 bytes | 76% |
| 100% active / 50% retry | 34,156,544 bytes | 15,683,584 bytes | 54% |
| 100% active / 100% retry | 31,539,200 bytes | 15,790,080 bytes | 50% |

At eight million deliveries, the all-retry model projects about 1.26 GB growth.
Production's later read-only check measured 8,977,735,680 bytes; that model plus
the 500 MB reserve does **not** fit. Do not approve the migration from this model.

Freed pages are reused without VACUUM. These figures measure allocated SQLite
pages, not D1 execution time, temporary sort space, or the live population's
distribution. They are not production capacity approval.

Before DDL, require a reviewed worst-case growth budget, current database size,
and explicit reserve for concurrent growth. Cloud's rollout gate requires
`size + approved growth + 500 MB <= 10 GB`; missing approval blocks promotion.
Production measured about 8.94 GB on September 8 and may have grown since.
Do not set the budget from high-water row IDs or small samples alone.

Index construction still consumes the D1 writer and may exceed query-duration
limits. Schedule and observe the migration; verify schema, migration journal,
bounded query plans, and interactive attach latency before worker promotion.
If capacity or duration cannot be demonstrated safe, obtain approval for a
separate capacity plan (for example migration to a new database or an explicitly
approved retention cleanup). This migration does not authorize either action.
