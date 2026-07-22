# Operations guide

This guide uses the Worker and D1 database names currently configured in `wrangler.toml`: `uptime-worker` and `uptime_worker_d1`.

## Monitor health

The cron runs every minute. Query `https://<STATUS_HOST>/api/health` from outside Cloudflare. A healthy response is HTTP 200 with this shape (timestamps vary):

```json
{"monitoringStatus":"healthy","updatedAt":<UNIX_SECONDS>,"stale":false}
```

Absent state is `initializing`: it returns HTTP 503 with `monitoringStatus: "initializing"`, `updatedAt: 0`, and `stale: true`. A fresh timestamp is not sufficient for readiness: zero configured monitors, or any configured monitor without a persisted sample, also returns HTTP 503 with `monitoringStatus: "initializing"` and `stale: false`. HTTP 503 and `monitoringStatus: "delayed"` means the last state is older than 180 seconds. Corrupt or unreadable state returns HTTP 503 with `{"error":"State unavailable"}`. Alert on any non-200 response.

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

`wrangler.toml` enables Workers Logs only for the allowlisted application events above, with a 1% head-sampling rate. Automatic invocation logs and traces are disabled so request metadata and trace payloads are not retained. Sampling reduces stored volume but is not a spending cap; review Cloudflare usage and the configured monitor count before changing the rate.

## Final release candidate — 2026-07-22

The only release candidate is the final reviewed head that contains all remediation waves, including the final readiness fixes. Resolve and record its full immutable SHA immediately before building:

```sh
RELEASE_COMMIT="$(git rev-parse HEAD)"
git status --short
git show --no-patch --format='%H %s' "$RELEASE_COMMIT"
```

The worktree must be clean, the subject must be `fix: align health and release readiness`, and the recorded SHA must match the reviewed final-head gate report. Build one immutable artifact from `RELEASE_COMMIT`; do not rebuild from or deploy an earlier intermediate commit. If a staged rollout truly requires different code artifacts, stop and require each artifact to be rebuilt, independently reviewed, and fully verified before it receives its own approval.

### Local verification record

Fresh final-wave commands ran locally with Node.js 26.5.0 and npm 11.17.0. `npm run check` passed 17 test files and 201 tests, followed by `tsc --noEmit` with exit status 0. `npm run deploy:dry-run` exited 0, read 19 static assets, and reported the expected `RemoteChecker`, `Scheduler`, `UPTIME_WORKER_D1`, and `ASSETS` bindings without uploading or deploying. `npm audit --omit=dev --json` reported zero production-dependency vulnerabilities, and `git diff --check` exited 0. These are local results, not production evidence. Re-run them after checking out the recorded `RELEASE_COMMIT`; the detailed TDD and command record is `.superpowers/sdd/final-wave-d-report.md`.

### Production status

No production action was performed. No remote D1 inspection, export, migration, or Time Travel action was run. No Worker version was uploaded, deployed, promoted, or rolled back. No secret was read or rotated. No real monitor, cron, heartbeat, webhook, or notification was triggered. No production request, Cloudflare log search, observation window, or external health-monitor check was performed. Those steps require an approved production change window and remain open below.

### One-artifact production rollout checklist

- [ ] Preflight: use Node 22.13.0 or newer; check out the recorded `RELEASE_COMMIT`; require a clean worktree; re-run clean install, `npm run check`, `npm run deploy:dry-run`, the production dependency audit, and independent review. Record the current known-good Worker version, D1 information, recovery timestamp, and portable remote export.
- [ ] Migration gate: confirm every migration is forward-compatible with the recorded rollback version, then apply the reviewed remote migrations once. Stop on any unexpected schema or data result.
- [ ] Deploy the one reviewed artifact once and record its Worker version and artifact digest. Do not rebuild between the observation gates below.
- [ ] Observation gate 1 — status and security, at least 30 minutes: verify log redaction, sampled application-log availability, stale/unknown API and UI behavior, badge 404 behavior, protected assets, security headers, `/api/health`, API errors, and configured monitor states.
- [ ] Observation gate 2 — scheduler and delivery, at least two additional hours: verify isolated probe failures, `monitor_runs`, Outbox pending/delivery behavior, notification deduplication, and external heartbeat delivery. Continue only if gate 1 remained clean.
- [ ] Observation gate 3 — presentation and accessibility: verify all five languages, incident history, timezone/DST display, keyboard and reduced-motion behavior, and the external dead-man's-switch monitor. Continue only if gates 1 and 2 remained clean.
- [ ] Production acceptance: trigger one approved test monitor through DOWN, grace, and UP; confirm exactly one down event key and one recovery event key. Stop cron long enough to confirm `Monitoring delayed` after 181 seconds, then restore cron and confirm healthy status within one run. Review any retained sampled application events for the documented allowlisted schema; the absence of a sampled event is inconclusive and must not be treated as proof of redaction.

### Rollback criteria and response

Stop the active batch and begin rollback review if any of these occurs: `/api/health` returns 503 continuously for three minutes; all monitors become `unknown` together; Outbox pending count grows for five consecutive dispatch rounds; or API 5xx exceeds 1% during the observation window. Also stop for credential or response-body disclosure, an authentication bypass, loss of stored state, or repeated notification event keys.

For a Worker-only regression with compatible data, roll back to the recorded known-good Worker version and repeat health and data checks. A Worker rollback does not revert D1 or Durable Object state. Do not reverse or restore D1 automatically; if schema/data compatibility is uncertain, stop traffic-changing work and choose an approved forward-compatible hotfix or the separately reviewed D1 recovery procedure using the recorded export or Time Travel point.
