-- Normalize legacy delivery rows to the public durable-delivery status
-- contract. Migration 0010 defaulted `status` to 'pending', while every modern
-- insert path writes 'accepted'. Promoting historical rows keeps upgraded
-- delivery queues visible through GET /v1/deliveries.
UPDATE deliveries SET status = 'accepted' WHERE status = 'pending';
