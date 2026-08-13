-- Per-run summaries were never read by the application and amplified D1 writes
-- once per minute. Current state and transition notifications remain durable.
DROP TABLE IF EXISTS monitor_runs;
