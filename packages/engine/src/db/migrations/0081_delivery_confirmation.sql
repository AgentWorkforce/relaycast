-- Delivery confirmation: the receiving software's acceptance of a row
-- (`delivery.accepted`, or an http_push 2xx) and the recipient's DM reply are
-- recorded beside the existing transitions so a sender can tell a socket write
-- from a durable receipt, and a consumed delivery from an answered one.
-- Nullable, no backfill: rows settled before this column are reported from
-- their existing status.
ALTER TABLE deliveries ADD COLUMN accepted_at INTEGER;
ALTER TABLE deliveries ADD COLUMN replied_at INTEGER;
ALTER TABLE deliveries ADD COLUMN reply_message_id TEXT;

-- A reply names the message it answers (`reply_to_message_id` on POST /v1/dm,
-- the parent of a thread reply), so `replied` is an explicit correlation,
-- never inferred from conversation order.
ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;
