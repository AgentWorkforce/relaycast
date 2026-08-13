ALTER TABLE workspaces ADD COLUMN sponsor_org_id TEXT;

ALTER TABLE agents ADD COLUMN sponsor_org_id TEXT;
ALTER TABLE agents ADD COLUMN sponsor_id TEXT;
ALTER TABLE agents ADD COLUMN sponsor_oidc_issuer TEXT;
ALTER TABLE agents ADD COLUMN sponsor_oidc_subject TEXT;
ALTER TABLE agents ADD COLUMN work_unit_key_hash TEXT;
ALTER TABLE agents ADD COLUMN sponsor_proof_hash TEXT;
ALTER TABLE agents ADD COLUMN sponsor_bound_at INTEGER;

-- Tombstone-style credential ownership survives deletion of the live agent
-- row. Without this, a workspace-key holder could delete a protected identity
-- and immediately register the same name under a different sponsor.
CREATE TABLE agent_credential_claims (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  sponsor_org_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  sponsor_oidc_issuer TEXT NOT NULL,
  sponsor_oidc_subject TEXT NOT NULL,
  work_unit_key_hash TEXT NOT NULL,
  claimed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, agent_name)
);
CREATE INDEX idx_agent_credential_claims_workspace ON agent_credential_claims(workspace_id);

-- A sponsored agent may only live in the trust domain pinned on its workspace.
-- This trigger is also the concurrency guard for first registration: a losing
-- cross-org workspace-pin race aborts credential issuance instead of creating
-- an agent under the wrong organization.
CREATE TRIGGER agents_sponsor_org_insert_guard
BEFORE INSERT ON agents
WHEN NEW.sponsor_org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspaces
    WHERE id = NEW.workspace_id AND sponsor_org_id = NEW.sponsor_org_id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_sponsor_org_mismatch');
END;

CREATE TRIGGER agents_sponsor_org_update_guard
BEFORE UPDATE OF sponsor_org_id ON agents
WHEN NEW.sponsor_org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspaces
    WHERE id = NEW.workspace_id AND sponsor_org_id = NEW.sponsor_org_id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_sponsor_org_mismatch');
END;

-- The route checks the durable name claim before it starts the registration
-- transaction, but another request can claim the same name between that check
-- and the INSERT on concurrent engine hosts. Make the database re-check the
-- complete binding at the mutation boundary. The claim INSERT is deliberately
-- the first statement in each sponsored registration batch.
CREATE TRIGGER agents_credential_claim_insert_guard
BEFORE INSERT ON agents
WHEN NEW.sponsor_org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_credential_claims
    WHERE workspace_id = NEW.workspace_id
      AND agent_name = NEW.name
      AND sponsor_org_id = NEW.sponsor_org_id
      AND sponsor_id = NEW.sponsor_id
      AND sponsor_oidc_issuer = NEW.sponsor_oidc_issuer
      AND sponsor_oidc_subject = NEW.sponsor_oidc_subject
      AND work_unit_key_hash = NEW.work_unit_key_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_credential_claim_mismatch');
END;

-- Legacy migration is the only permitted NULL -> sponsored transition. It too
-- must match the durable name claim inside the same atomic unit, so a stale
-- preflight decision cannot bind an incumbent row after a competing claim won.
CREATE TRIGGER agents_credential_claim_update_guard
BEFORE UPDATE OF sponsor_org_id, sponsor_id, sponsor_oidc_issuer,
  sponsor_oidc_subject, work_unit_key_hash
ON agents
WHEN OLD.sponsor_org_id IS NULL AND NEW.sponsor_org_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_credential_claims
    WHERE workspace_id = NEW.workspace_id
      AND agent_name = NEW.name
      AND sponsor_org_id = NEW.sponsor_org_id
      AND sponsor_id = NEW.sponsor_id
      AND sponsor_oidc_issuer = NEW.sponsor_oidc_issuer
      AND sponsor_oidc_subject = NEW.sponsor_oidc_subject
      AND work_unit_key_hash = NEW.work_unit_key_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_credential_claim_mismatch');
END;

-- Sponsor and work-unit bindings are write-once. Legacy rows may transition
-- from all-NULL to a verified binding through the agent-token migration route;
-- after that, neither public metadata writes nor an internal programming error
-- can transfer the credential to another sponsor/work unit.
CREATE TRIGGER agents_credential_authority_immutable
BEFORE UPDATE OF sponsor_org_id, sponsor_id, sponsor_oidc_issuer,
  sponsor_oidc_subject, work_unit_key_hash, sponsor_proof_hash, sponsor_bound_at
ON agents
WHEN OLD.sponsor_org_id IS NOT NULL
  OR OLD.sponsor_id IS NOT NULL
  OR OLD.sponsor_oidc_issuer IS NOT NULL
  OR OLD.sponsor_oidc_subject IS NOT NULL
  OR OLD.work_unit_key_hash IS NOT NULL
  OR OLD.sponsor_proof_hash IS NOT NULL
  OR OLD.sponsor_bound_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_credential_authority_immutable');
END;

CREATE TRIGGER workspace_sponsor_org_immutable
BEFORE UPDATE OF sponsor_org_id ON workspaces
WHEN OLD.sponsor_org_id IS NOT NULL AND NEW.sponsor_org_id IS NOT OLD.sponsor_org_id
BEGIN
  SELECT RAISE(ABORT, 'workspace_sponsor_org_immutable');
END;
