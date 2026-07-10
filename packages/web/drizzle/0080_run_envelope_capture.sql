-- cloud#1841: persist the exact gateway envelope delivered to each run so
-- real fires become replayable `agentworkforce invoke --fixture` fixtures
-- (workforce#189).
--
-- agent_deployment_runs.envelope stores the byte-exact JSON piped to
-- runner.mjs. ALL-OR-NOTHING: oversized envelopes are OMITTED (NULL +
-- envelope_omitted=true), never truncated — a truncated JSON envelope
-- replays WRONG, which is strictly worse than absent.
ALTER TABLE "agent_deployment_runs"
  ADD COLUMN IF NOT EXISTS "envelope" text;
ALTER TABLE "agent_deployment_runs"
  ADD COLUMN IF NOT EXISTS "envelope_omitted" boolean NOT NULL DEFAULT false;

-- deployment_tick_deliveries.run_envelope carries the exact delivered
-- envelope across the async poll boundary (the run row is only inserted at
-- completion, which can happen in a later request; rebuilding from payload
-- at record time would NOT reproduce the delivered bytes — buildEnvelope's
-- id/occurredAt fallbacks are non-deterministic).
ALTER TABLE "deployment_tick_deliveries"
  ADD COLUMN IF NOT EXISTS "run_envelope" text;
