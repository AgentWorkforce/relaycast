-- Standard Webhooks remains opt-in; existing subscriptions retain the legacy
-- X-Relay-Signature contract.
ALTER TABLE event_subscriptions
  ADD COLUMN signature_scheme TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE pending_events
  ADD COLUMN webhook_initialized INTEGER NOT NULL DEFAULT 0;

-- One durable retry state per (outbox event, subscription). Successful
-- subscribers are never re-sent when another target is down, and exhausted
-- rows remain queryable/replayable while the failed parent outbox row exists.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES pending_events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_error TEXT,
  last_status INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE UNIQUE INDEX webhook_deliveries_event_subscription_unique
  ON webhook_deliveries(event_id, subscription_id);
CREATE INDEX idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_subscription
  ON webhook_deliveries(subscription_id, created_at);

-- Older queued events used five parent attempts. Per-target delivery now owns
-- the seven-attempt retry horizon; give in-flight parents crash/lease headroom.
UPDATE pending_events
  SET max_attempts = 32
  WHERE status = 'pending' AND max_attempts < 32;
