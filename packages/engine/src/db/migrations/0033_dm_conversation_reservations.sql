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

-- PRE-FLIGHT AUDIT (run BOTH read-only queries BEFORE applying this migration).
-- The backfill can abort for two independent reasons, and each needs its own
-- check. An earlier version of this comment shipped only query (a) and claimed an
-- empty result meant the migration would apply cleanly. That was wrong: a
-- duplicate pair passes (a) and still aborts the backfill on the pair-uniqueness
-- index. Raised in review of PR #303.
--
-- (a) Roster shape. The backfill aborts if any single legacy 1:1 has a roster
--     that is not 1 or 2 distinct participants. That is deliberate - inventing a
--     tuple would bind a conversation to the wrong pair - but one corrupt row
--     blocks the whole deployment.
--
--   SELECT dc.id, dc.workspace_id, COUNT(DISTINCT dp.agent_id) AS participants
--   FROM dm_conversations dc
--   LEFT JOIN dm_participants dp ON dp.conversation_id = dc.id
--   WHERE dc.dm_type = '1:1'
--   GROUP BY dc.id, dc.workspace_id
--   HAVING participants NOT BETWEEN 1 AND 2;
--
-- (b) Duplicate pairs. Two DISTINCT legacy 1:1 conversations in one workspace
--     that resolve to the same sorted pair both satisfy (a), but only one can be
--     reserved - the second violates dm_conversation_reservations_pair_unique and
--     aborts the migration. This is exactly what a pre-deterministic id scheme
--     leaves behind, so it is the likelier of the two in practice.
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
--     HAVING COUNT(DISTINCT dp.agent_id) BETWEEN 1 AND 2
--   )
--   GROUP BY workspace_id, participant_one_id, participant_two_id
--   HAVING conversations > 1;
--
-- (c) Ids that do not match the CURRENT derivation. This one cannot be written
--     in SQL - it needs SHA-256, which SQLite does not have - and it is the check
--     that matters most operationally, because it is the only failure that is
--     INVISIBLE AT MIGRATION TIME. (a) and (b) abort the migration loudly. (c)
--     lets it succeed, and then every subsequent DM between that pair returns 409
--     forever, because the backfill reserved the pair under an id the send path
--     will never re-derive.
--
--     Run:  node scripts/audit-dm-reservations.mjs --sqlite <path>
--     D1:   wrangler d1 execute <DB> --json --command "<see script header>" \
--             | node scripts/audit-dm-reservations.mjs --stdin
--
--     That script also re-runs (a) and (b), so it is the single command to trust.
--
-- All three clean means this migration will apply AND no existing pair will start
-- failing afterwards. Remediate anything any of them returns - for (b) that means
-- deciding which conversation survives, since the reservation can only bind one;
-- for (c) it means re-keying the conversation to the derived id, or seeding its
-- reservation under the derived id, before deploying the code that reserves.

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
