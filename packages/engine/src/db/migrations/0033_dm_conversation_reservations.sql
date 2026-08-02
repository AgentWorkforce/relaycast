-- Bind every deterministic 1:1 DM id to the workspace and sorted participant
-- pair that derived it. The primary key is the atomic reservation seam: a
-- conflicting digest can never overwrite or alias another pair's conversation.
CREATE TABLE dm_conversation_reservations (
  conversation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  participant_one_id TEXT NOT NULL,
  participant_two_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT dm_conversation_reservations_sorted_pair_check
    CHECK (participant_one_id <= participant_two_id)
);

CREATE UNIQUE INDEX dm_conversation_reservations_pair_unique
  ON dm_conversation_reservations (workspace_id, participant_one_id, participant_two_id);

-- PRE-FLIGHT AUDIT — run BEFORE applying this migration.
--
-- The single command to trust is the script in (b); it runs both checks. The SQL
-- in (a) is here so the cheap check can be run by hand without Node.
--
-- (a) DUPLICATE PAIRS among the conversations that will be reserved. Two
--     distinct 1:1 conversations in one workspace resolving to the same sorted
--     pair can only yield one reservation; the second violates
--     dm_conversation_reservations_pair_unique and ABORTS this migration.
--
--   SELECT workspace_id, participant_one_id, participant_two_id,
--          COUNT(*) AS conversations
--   FROM (
--     SELECT dc.workspace_id,
--            MIN(dp.agent_id) AS participant_one_id,
--            MAX(dp.agent_id) AS participant_two_id
--     FROM dm_conversations dc
--     JOIN dm_participants dp ON dp.conversation_id = dc.id
--     WHERE dc.dm_type = '1:1'
--     GROUP BY dc.id, dc.workspace_id
--     HAVING COUNT(DISTINCT dp.agent_id) = 2
--   )
--   GROUP BY workspace_id, participant_one_id, participant_two_id
--   HAVING conversations > 1;
--
--     The `= 2` must match the backfill below. An earlier revision of this
--     comment carried `BETWEEN 1 AND 2`, left over from when the backfill also
--     reserved one-row rosters; run by hand it reports phantom blockers, because
--     one-row rosters are no longer reserved and cannot collide.
--
-- (b) IDS THAT DO NOT MATCH THE CURRENT DERIVATION. This cannot be expressed in
--     SQL — it needs SHA-256, which SQLite does not have — and it is the check
--     that matters most, because it is the only failure that is INVISIBLE AT
--     MIGRATION TIME. (a) aborts loudly. (b) lets the migration succeed, and then
--     every subsequent DM between that pair returns 409 forever, because the pair
--     was reserved under an id the send path will never re-derive.
--
--     Run:  node scripts/audit-dm-reservations.mjs --sqlite <path>
--     D1:   wrangler d1 execute <DB> --json --command "<see script header>" \
--             | node scripts/audit-dm-reservations.mjs --stdin
--
--     The script runs (a) as well, and additionally reports the skipped one-row
--     rosters split into genuine self-DMs and orphaned two-party conversations.
--
-- Clean means this migration applies AND no existing pair starts failing
-- afterwards. Remediate anything either check returns — for (a) that means
-- deciding which conversation survives, since a pair can hold only one
-- reservation; for (b) it means re-keying the conversation to the derived id, or
-- seeding its reservation under the derived id, before deploying.

-- Backfill ONLY conversations with exactly two distinct participants.
--
-- A one-row roster is ambiguous and MUST NOT be reserved. It looks like a
-- self-DM, but `dm_participants.agent_id` cascades on agent deletion, so a
-- perfectly ordinary two-party 1:1 collapses to a single row the moment one
-- participant's agent is deleted - while its id still encodes the ORIGINAL pair.
--
-- Reading those as (X, X) is wrong twice over. Several orphans belonging to the
-- same surviving agent all collapse to the same (workspace, X, X) tuple and
-- collide on the pair-uniqueness index, aborting the migration; and any that
-- survived would reserve a self-DM tuple against an id no derivation produces,
-- so that agent's next self-DM would 409 forever.
--
-- This is not hypothetical. An earlier version of this backfill used
-- MIN/MAX over 1-2 participants; audited against production it produced 4
-- colliding pair groups and 30 mismatched ids, all of them orphaned two-party
-- conversations, and would have failed the deployment. Restricted to exactly two
-- participants the same data yields zero findings across 3425 conversations.
--
-- Skipping is safe rather than merely convenient. An unreserved conversation is
-- in exactly the state every conversation was in before this migration: the
-- first send through the reservation path claims it, and because a genuine
-- self-DM's id already equals its derivation, that claim adopts the existing
-- conversation instead of creating a second one. Orphaned two-party rows are
-- simply never re-derived, so they stay readable and inert.
--
-- Malformed rosters (zero, or more than two) are skipped for the same reason.
-- The earlier version aborted the whole migration on them; skipping avoids
-- inventing a tuple just as effectively without blocking a deployment, and any
-- future send still goes through the reservation path.
INSERT INTO dm_conversation_reservations (
  conversation_id,
  workspace_id,
  participant_one_id,
  participant_two_id,
  created_at
)
SELECT
  dc.id,
  dc.workspace_id,
  MIN(dp.agent_id),
  MAX(dp.agent_id),
  dc.created_at
FROM dm_conversations dc
JOIN dm_participants dp ON dp.conversation_id = dc.id
WHERE dc.dm_type = '1:1'
GROUP BY dc.id, dc.workspace_id, dc.created_at
HAVING COUNT(DISTINCT dp.agent_id) = 2;
