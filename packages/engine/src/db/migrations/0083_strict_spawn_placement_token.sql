-- A non-null token means a strict builtin spawn is durably bound to its exact
-- node and is definitely unsent. The pre-send dispatch CAS clears the token.
ALTER TABLE action_invocations ADD COLUMN spawn_placement_token TEXT;
