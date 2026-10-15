-- Bounded agent access credentials. Legacy rows remain NULL until the
-- operator's staged rotation/backfill; enabling expiry alone must not turn a
-- schema migration into an unannounced outage for existing clients.
ALTER TABLE agents ADD COLUMN token_expires_at INTEGER DEFAULT NULL;
