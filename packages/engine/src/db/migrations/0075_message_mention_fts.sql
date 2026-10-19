-- Inbox mention lookup used to LIKE-scan a workspace's message history, which
-- stalled the shared D1. The existing messages_fts index has no workspace
-- column, so a body-only MATCH materializes every tenant's hits before the
-- workspace predicate. This index carries workspace_id as a searchable column
-- so the MATCH itself is one workspace. unicode61 splits `_`/`-` and case-folds,
-- matching the mention tokenizer; the query prefixes the last token so a
-- handle glued to a trailing non-ASCII letter still matches. Rebuild reads
-- messages once. No data changes.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_mention_fts USING fts5(
  workspace_id,
  body,
  content=messages,
  content_rowid=rowid,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_mention_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_mention_fts(rowid, workspace_id, body)
  VALUES (NEW.rowid, NEW.workspace_id, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_mention_fts_update AFTER UPDATE OF body, workspace_id ON messages BEGIN
  INSERT INTO messages_mention_fts(messages_mention_fts, rowid, workspace_id, body)
  VALUES ('delete', OLD.rowid, OLD.workspace_id, OLD.body);
  INSERT INTO messages_mention_fts(rowid, workspace_id, body)
  VALUES (NEW.rowid, NEW.workspace_id, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_mention_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_mention_fts(messages_mention_fts, rowid, workspace_id, body)
  VALUES ('delete', OLD.rowid, OLD.workspace_id, OLD.body);
END;

INSERT INTO messages_mention_fts(messages_mention_fts) VALUES('rebuild');
