-- Normalize legacy delivery rows to the public status contract.
-- The deliveries table (migration 0010) defaulted `status` to 'pending', but the
-- public DeliveryStatus contract is accepted | delivered | deferred | failed, and
-- every insert path now writes 'accepted' explicitly. Any historical 'pending'
-- rows (created before that, via the old column default) would be invisible to
-- GET /v1/deliveries (which lists accepted + deferred) and would fall outside the
-- typed status enum. Promote them to 'accepted' so upgraded queues stay visible
-- and consistent. Idempotent: a no-op once no 'pending' rows remain.
UPDATE deliveries SET status = 'accepted' WHERE status = 'pending';
