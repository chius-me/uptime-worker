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

## Local release rehearsal — 2026-07-22

This record covers a local rehearsal of commit `0d2a6ec` from the `codex/review-remediation` branch. It is **not** evidence of a production deployment or production acceptance. The commands ran with Node.js 26.5.0 and npm 11.17.0 in a clean worktree.

### Performed locally

- `npm ci --cache /private/tmp/uptime-worker-npm-cache` completed and installed 123 packages. npm reported four high-severity development-toolchain findings and pending install-script approvals; the subsequent test, typecheck, Wrangler, and migration commands completed successfully.
- `npm run check` passed all 17 test files and 149 tests, followed by `tsc --noEmit` with exit status 0. This includes the containment, probe isolation, state-machine, outbox, static-asset authorization, UI, documentation, and Worker integration gates from the staged plan.
- `npm run deploy:dry-run` exited 0, read 19 static assets, and reported the expected `RemoteChecker`, `Scheduler`, `UPTIME_WORKER_D1`, and `ASSETS` bindings. It did not upload or deploy anything.
- The first `npm run d1:migrate:local` applied `0001_initial.sql` and `0002_notification_outbox.sql` to the worktree-local D1 store. A local sentinel row was then inserted into `uptimeflare`. The second migration run reported `No migrations to apply`, and a follow-up query returned both migration names and the unchanged sentinel value `preserved-2026-07-22`.
- `npx vitest run tests/store.test.ts -t "migrates v1"` passed one focused test with 12 non-matching tests skipped. The test verifies v1 incident and latency preservation, suppression of the dummy incident, and write-back as schema version 2.
- `npm audit --omit=dev --json` reported zero production-dependency vulnerabilities. The full audit reported four high-severity entries, all from one transitive `sharp <0.35.0` advisory propagated through the development-only path `@cloudflare/vitest-pool-workers -> miniflare -> sharp` and Wrangler; npm reported no fix available. A policy requiring a completely clean full audit remains a release blocker even though the Worker has no production dependency on this path.

The repository now declares Node.js `>=22.13.0`, matching the Node 22 floor required by jsdom 29.1.1. CI uses the current Node 22 release, and release tooling must honor the declared engine range.

### Not performed

No remote D1 inspection, export, migration, or Time Travel action was run. No Worker version was uploaded, deployed, promoted, or rolled back. No secret was read or rotated. No real monitor, cron, heartbeat, webhook, or notification was triggered. No production request, Cloudflare log search, observation window, or external health-monitor check was performed. Those steps require an approved production change window and remain open below.

### Staged production rollout checklist

- [ ] Preflight: use Node 22.13 or newer; re-run clean install, `npm run check`, `npm run deploy:dry-run`, and the dependency-policy review for each exact batch commit below; record the current known-good Worker version, D1 information, recovery timestamp, and portable remote export.
- [ ] Batch 1 — Tasks 1–3 and 7: deploy reviewed cumulative commit `3f90900` (or an immutable artifact built from it), then record the resulting Worker version as this batch's rollback target. Verify log redaction, stale/unknown API and UI behavior, badge 404 behavior, protected assets, and security headers; observe `/api/health`, API errors, and monitor states for at least 30 minutes.
- [ ] Batch 2 — Tasks 4–6: apply the reviewed remote migrations before deploying reviewed cumulative commit `c55b055` (or its immutable artifact), then record the resulting Worker version. Verify isolated probe failures, `monitor_runs`, Outbox pending/delivery behavior, and notification deduplication; observe for at least two hours.
- [ ] Batch 3 — Tasks 8–10: deploy reviewed cumulative commit `0d2a6ec` (or its immutable artifact), then record the resulting Worker version. Verify all five languages, incident history, timezone/DST display, keyboard and reduced-motion behavior, PR CI, and the external dead-man's-switch monitor.
- [ ] Production acceptance: trigger one approved test monitor through DOWN, grace, and UP; confirm exactly one down event key and one recovery event key. Stop cron long enough to confirm `Monitoring delayed` after 181 seconds, restore cron and confirm healthy status within one run, then search Cloudflare logs for the old token, chat ID, authorization value, and test response body with no matches.

### Rollback criteria and response

Stop the active batch and begin rollback review if any of these occurs: `/api/health` returns 503 continuously for three minutes; all monitors become `unknown` together; Outbox pending count grows for five consecutive dispatch rounds; or API 5xx exceeds 1% during the observation window. Also stop for credential or response-body disclosure, an authentication bypass, loss of stored state, or repeated notification event keys.

For a Worker-only regression with compatible data, roll back to the recorded known-good Worker version and repeat health and data checks. A Worker rollback does not revert D1 or Durable Object state. Do not reverse or restore D1 automatically; if schema/data compatibility is uncertain, stop traffic-changing work and choose an approved forward-compatible hotfix or the separately reviewed D1 recovery procedure using the recorded export or Time Travel point.
