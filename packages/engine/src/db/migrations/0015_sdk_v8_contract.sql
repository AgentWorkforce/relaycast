-- SDK v8 service contract support.
-- Inbound webhooks are now authenticated by a per-webhook bearer token.
ALTER TABLE webhooks ADD COLUMN token_hash TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token_hash);

-- Outbound event subscriptions can carry caller-supplied delivery headers.
ALTER TABLE event_subscriptions ADD COLUMN headers TEXT DEFAULT NULL;
