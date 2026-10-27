-- relay#1542. Give `POST /agents/:name/rotate-token` a two-slot outcome so
-- concurrent rotations do not silently strand the earlier caller with a token
-- that stopped authenticating between the response body and the next request.
-- The prior credential is retained in `previous_token_hash` until
-- `previous_token_expires_at`, then the auth path stops honouring it.
--
-- Nullable and unbounded so a first-ever rotate on a legacy row is trivial
-- (both columns stay NULL until the second write moves the current hash into
-- the previous slot). No UNIQUE constraint on `previous_token_hash`: a random
-- 256-bit token collision is a non-event, and enforcing global uniqueness
-- across current+previous would abort otherwise-correct rotations.
ALTER TABLE agents ADD COLUMN previous_token_hash TEXT;
ALTER TABLE agents ADD COLUMN previous_token_expires_at INTEGER;

-- The auth path fans out to a second lookup by `previous_token_hash` on a
-- miss against `token_hash`; without this index every rejected token pays a
-- full-table scan.
CREATE INDEX IF NOT EXISTS idx_agents_previous_token ON agents(previous_token_hash);
