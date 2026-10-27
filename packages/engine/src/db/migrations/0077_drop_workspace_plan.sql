-- Plan tiers belong to the host that bills for them; the engine stores none.
-- A host that keeps tiers must copy `workspaces.plan` into its own storage
-- before applying this migration.
ALTER TABLE `workspaces` DROP COLUMN `plan`;
