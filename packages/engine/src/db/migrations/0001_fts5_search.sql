-- FTS5 virtual table for message full-text search.
-- Uses external content mode so the FTS index mirrors the messages table.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED,
  body,
  content=messages,
  content_rowid=rowid
);

-- Keep FTS index in sync via triggers.
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, id, body) VALUES (NEW.rowid, NEW.id, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, id, body) VALUES('delete', OLD.rowid, OLD.id, OLD.body);
  INSERT INTO messages_fts(rowid, id, body) VALUES (NEW.rowid, NEW.id, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, id, body) VALUES('delete', OLD.rowid, OLD.id, OLD.body);
END;
