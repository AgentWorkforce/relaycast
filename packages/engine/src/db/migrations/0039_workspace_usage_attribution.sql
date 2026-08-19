-- Durable creation provenance and explicit usage classification.
--
-- Existing rows remain honestly unclassified: provenance is NULL and the
-- classification defaults to `unknown`. Historical heuristics belong in the
-- reporting layer and must never be written into these recorded-fact columns.
ALTER TABLE workspaces ADD COLUMN provenance TEXT;
ALTER TABLE workspaces ADD COLUMN usage_classification TEXT NOT NULL DEFAULT 'unknown'
  CHECK (usage_classification IN ('internal', 'external', 'unknown'));
ALTER TABLE workspaces ADD COLUMN classification_source TEXT NOT NULL DEFAULT 'unclassified'
  CONSTRAINT workspaces_usage_classification_source_check CHECK (
    classification_source IN ('creator', 'operator', 'unclassified')
    AND (
      (usage_classification = 'unknown' AND classification_source = 'unclassified')
      OR (
        usage_classification IN ('internal', 'external')
        AND classification_source IN ('creator', 'operator')
      )
    )
  );
ALTER TABLE workspaces ADD COLUMN classification_reason TEXT;
ALTER TABLE workspaces ADD COLUMN classified_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_workspaces_usage_classification
  ON workspaces(usage_classification, created_at);
