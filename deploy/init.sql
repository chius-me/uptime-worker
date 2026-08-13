CREATE TABLE IF NOT EXISTS uptimeflare (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  event_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error_code TEXT
);

CREATE INDEX IF NOT EXISTS notification_outbox_due
  ON notification_outbox (status, next_attempt_at, event_key);

CREATE INDEX IF NOT EXISTS notification_outbox_delivered
  ON notification_outbox (status, delivered_at, event_key);

CREATE INDEX IF NOT EXISTS notification_outbox_pending_monitor
  ON notification_outbox (status, event_key);
