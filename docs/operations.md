# Operations guide

This guide uses the Worker and D1 database names currently configured in `wrangler.toml`: `uptime-worker` and `uptime_worker_d1`.

## Monitor health

The cron runs every minute. Query `https://<STATUS_HOST>/api/health` from outside Cloudflare. A healthy response is HTTP 200 with this shape (timestamps vary):

```json
{"monitoringStatus":"healthy","updatedAt":<UNIX_SECONDS>,"stale":false}
```

Absent state is `initializing`: it returns HTTP 503 with `monitoringStatus: "initializing"`, `updatedAt: 0`, and `stale: true`. HTTP 503 and `monitoringStatus: "delayed"` means the last state is older than 180 seconds. Corrupt or unreadable state returns HTTP 503 with `{"error":"State unavailable"}`. Alert on any non-200 response.

Set `HEARTBEAT_URL` with `npx wrangler secret put HEARTBEAT_URL`. Configure Healthchecks, Better Stack, or an equivalent external dead-man's switch to expect a ping every 1 minute with a 3-minute grace period. The Worker sends the HTTPS GET only after monitoring state and run metadata have been persisted; a heartbeat proves that boundary was reached, not that monitored systems are healthy.

## Secrets and Telegram rotation

Rotate a Telegram credential by first obtaining the replacement value through Telegram, then run these commands interactively:

```sh
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
```

After each command, check `/api/health` and trigger or wait for a notification test appropriate to the deployment. `wrangler secret put` creates and deploys a Worker version, so rotate during a change window; do not paste a token into a command line, config, issue, or log. If an enabled configuration uses an unresolved `<SECRET_NAME>`, configuration resolution fails closed for that scheduled run. It does not silently send to a default target.

## D1 migrations and backup recovery

Before schema work, inspect the current database and export a portable recovery copy:

```sh
npx wrangler d1 info uptime_worker_d1
npx wrangler d1 export uptime_worker_d1 --remote --output <BACKUP_FILE>
```

Apply repository migrations with the package scripts:

```sh
npm run d1:migrate:local
npm run d1:migrate:remote
```

The remote script expands to `wrangler d1 migrations apply uptime_worker_d1 --remote`; migrations are ordered SQL files in `migrations/`. Do not use `deploy/init.sql` for normal deployments. For an existing legacy database initialized from that snapshot, apply the migrations once; their idempotent creation statements record migration history without replacing existing tables or data.

D1 Time Travel is always on for production storage. Confirm the backend with `npx wrangler d1 info uptime_worker_d1`; use Time Travel only after recording the intended recovery point:

```sh
npx wrangler d1 time-travel info uptime_worker_d1 --timestamp=<RFC3339_TIMESTAMP>
npx wrangler d1 time-travel restore uptime_worker_d1 --timestamp=<RFC3339_TIMESTAMP>
```

Restore is destructive: it overwrites the database in place and cancels in-flight queries and transactions. Treat the export and Time Travel bookmark as recovery controls, get approval, and verify state after recovery. See Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) for retention and production-storage prerequisites.

## Deployment rollback

First validate and release only compatible schema changes:

```sh
npm run deploy:dry-run
npm run deploy
npx wrangler deployments list
npx wrangler versions list
```

If a Worker deployment fails, identify the known-good version and run:

```sh
npx wrangler rollback <VERSION_ID>
```

Worker rollback changes the deployed Worker version only. It does **not** roll back D1, Durable Objects, or other resource state, so it can be unsafe after an incompatible schema change. Restore D1 independently only after the destructive-recovery review above; if compatibility is uncertain, deploy a forward-compatible hotfix instead.

## Notification outbox

The outbox is the durability boundary for notifications. State, run metadata, and unique notification rows are persisted together. The dispatcher retries pending rows and marks a row delivered only after webhook delivery and its confirmation write succeed. A failure after a receiver accepts a request but before confirmation can resend the same event; delivery is therefore at-least-once. Webhooks receive an `Idempotency-Key`, and receivers should deduplicate it.

Inspect pending work without exposing payloads or webhook credentials:

```sh
npx wrangler d1 execute uptime_worker_d1 --remote --command "SELECT event_key, status, attempts, next_attempt_at, last_error_code FROM notification_outbox WHERE status = 'pending' ORDER BY next_attempt_at ASC, event_key ASC;"
```

Do not manually mark an event delivered until you have confirmed the receiver's idempotent processing. Rows may be terminalized when their related monitor/incident no longer exists or their payload is invalid; inspect logs and state before taking corrective action.

## Privacy-safe logs

Allowed log fields are: event name; safe `monitorId`; `runId`; delivery kind; boolean up/down values; HTTP status; duration; ping; bounded location or Globalping measurement ID; webhook hostname and HTTP method; and coarse error category. Never log tokens, full webhook or heartbeat URLs, authorization/cookie values, request/response bodies, arbitrary proxy responses, or sensitive monitor targets.

For a custom proxy, allowlist the proxy hostname with `checkProxyAllowedHosts`. The Worker sends only its monitor DTO using `Content-Type: application/json`, does not forward `Authorization` or `Cookie`, and rejects proxy redirects. Review proxy access logs under the same policy.
