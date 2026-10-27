-- Inbox mention lookup used to LIKE-scan a workspace's message history, which
-- stalled the shared D1. The existing messages_fts index has no workspace
-- column, so a body-only MATCH materializes every tenant's hits before the
-- workspace predicate. This index carries workspace_id as a searchable column
-- so the MATCH itself is one workspace. unicode61 splits `_`/`-` and case-folds,
-- matching the mention tokenizer; the query prefixes the last token so a
-- handle glued to a trailing non-ASCII letter still matches. Existing rows are
-- copied later in bounded batches. A rebuild of every message body in this
-- file would hold D1 past its statement cap and recreate the overload.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_mention_fts USING fts5(
  workspace_id,
  body,
  content=messages,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- Deletes target docsize. A historical row is not indexed until the bounded
-- copy reaches it, so an edit or delete in that window must not issue a
-- delete command for a rowid the index has never stored.
CREATE TRIGGER IF NOT EXISTS messages_mention_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_mention_fts(rowid, workspace_id, body)
  SELECT NEW.rowid, NEW.workspace_id, NEW.body
  WHERE NOT EXISTS (
    SELECT 1 FROM messages_mention_fts_docsize WHERE id = NEW.rowid
  );
END;

CREATE TRIGGER IF NOT EXISTS messages_mention_fts_update AFTER UPDATE OF body, workspace_id ON messages BEGIN
  INSERT INTO messages_mention_fts(messages_mention_fts, rowid, workspace_id, body)
  SELECT 'delete', OLD.rowid, OLD.workspace_id, OLD.body
  WHERE EXISTS (
    SELECT 1 FROM messages_mention_fts_docsize WHERE id = OLD.rowid
  );
  INSERT INTO messages_mention_fts(rowid, workspace_id, body)
  SELECT NEW.rowid, NEW.workspace_id, NEW.body
  WHERE NOT EXISTS (
    SELECT 1 FROM messages_mention_fts_docsize WHERE id = NEW.rowid
  );
END;

CREATE TRIGGER IF NOT EXISTS messages_mention_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_mention_fts(messages_mention_fts, rowid, workspace_id, body)
  SELECT 'delete', OLD.rowid, OLD.workspace_id, OLD.body
  WHERE EXISTS (
    SELECT 1 FROM messages_mention_fts_docsize WHERE id = OLD.rowid
  );
END;

-- MAX(rowid) is the primary key, not a body scan. Rows inserted after this
-- point have a higher rowid and are covered by the trigger above.
INSERT INTO maintenance_cursors(id, cursor)
SELECT 'mention-fts-backfill',
  CASE
    WHEN EXISTS (SELECT 1 FROM messages)
      THEN '0/' || (SELECT MAX(rowid) FROM messages)
    ELSE 'complete'
  END
WHERE NOT EXISTS (
  SELECT 1 FROM maintenance_cursors WHERE id = 'mention-fts-backfill'
);
