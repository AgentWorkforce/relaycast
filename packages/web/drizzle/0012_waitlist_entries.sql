CREATE TABLE IF NOT EXISTS waitlist_entries (
  email TEXT PRIMARY KEY,
  email_status TEXT NOT NULL DEFAULT 'unconfirmed',
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_entries_email_status ON waitlist_entries(email_status);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_created_at ON waitlist_entries(created_at);
