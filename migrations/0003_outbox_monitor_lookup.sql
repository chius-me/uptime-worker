CREATE INDEX IF NOT EXISTS notification_outbox_pending_monitor
  ON notification_outbox (status, event_key);
