# Operations guide

This guide uses the Worker and D1 database names currently configured in `wrangler.jsonc`: `uptime-worker` and `uptime-worker-d1`.

## Monitor health

The cron runs every minute. Query `https://<STATUS_HOST>/api/health` from outside Cloudflare. A healthy response is HTTP 200 with this shape (timestamps vary):

```json
{"monitoringStatus":"healthy","updatedAt":<UNIX_SECONDS>,"stale":false}
```

Absent state is `initializing`: it returns HTTP 503 with `monitoringStatus: "initializing"`, `updatedAt: 0`, and `stale: true`. A fresh timestamp is not sufficient for readiness: zero configured monitors, or any configured monitor without a persisted sample, also returns HTTP 503 with `monitoringStatus: "initializing"` and `stale: false`. HTTP 503 and `monitoringStatus: "delayed"` means the last state is older than 180 seconds. Corrupt or unreadable state returns HTTP 503 with `{"error":"State unavailable"}`. Alert on any non-200 response.

Set `HEARTBEAT_URL` with `npx wrangler secret put HEARTBEAT_URL`. Configure Healthchecks, Better Stack, or an equivalent external dead-man's switch to expect a ping every 1 minute with a 3-minute grace period. The Worker sends the HTTPS GET only after monitoring state and notification events have been persisted; a heartbeat proves that boundary was reached, not that monitored systems are healthy.

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
npx wrangler d1 info uptime-worker-d1
npx wrangler d1 export uptime-worker-d1 --remote --output <BACKUP_FILE>
```

Apply repository migrations with the package scripts:

```sh
npm run d1:migrate:local
npm run d1:migrate:remote
```

The remote script expands to `wrangler d1 migrations apply uptime-worker-d1 --remote`; migrations are ordered SQL files in `migrations/`. Do not use `deploy/init.sql` for normal deployments. Back up an existing database first because migration `0004` removes the unused per-run history table.

D1 Time Travel is always on for production storage. Confirm the backend with `npx wrangler d1 info uptime-worker-d1`; use Time Travel only after recording the intended recovery point:

```sh
npx wrangler d1 time-travel info uptime-worker-d1 --timestamp=<RFC3339_TIMESTAMP>
npx wrangler d1 time-travel restore uptime-worker-d1 --timestamp=<RFC3339_TIMESTAMP>
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

The outbox is the durability boundary for notifications. State and unique notification rows are persisted together. Per-run summaries are logged; the historical monitor_runs table was removed by migration 0004. The dispatcher retries pending rows and marks a row delivered only after webhook delivery and its confirmation write succeed. A failure after a receiver accepts a request but before confirmation can resend the same event; delivery is therefore at-least-once. Webhooks receive an `Idempotency-Key`, and receivers should deduplicate it.

Inspect pending work without exposing payloads or webhook credentials:

```sh
npx wrangler d1 execute uptime-worker-d1 --remote --command "SELECT event_key, status, attempts, next_attempt_at, last_error_code FROM notification_outbox WHERE status = 'pending' ORDER BY next_attempt_at ASC, event_key ASC;"
```

Do not manually mark an event delivered until you have confirmed the receiver's idempotent processing. Rows may be terminalized when their related monitor/incident no longer exists or their payload is invalid; inspect logs and state before taking corrective action.

## Privacy-safe logs

Allowed log fields are: event name; safe `monitorId`; `runId`; delivery kind; boolean up/down values; HTTP status; duration; ping; bounded location or Globalping measurement ID; webhook hostname and HTTP method; and coarse error category. Never log tokens, full webhook or heartbeat URLs, authorization/cookie values, request/response bodies, arbitrary proxy responses, or sensitive monitor targets.

For a custom proxy, allowlist the proxy hostname with `checkProxyAllowedHosts`. The Worker sends only its monitor DTO using `Content-Type: application/json`, does not forward `Authorization` or `Cookie`, and rejects proxy redirects. Review proxy access logs under the same policy.

`wrangler.jsonc` enables Workers Logs only for the allowlisted application events above, with a 1% head-sampling rate. Automatic invocation logs and traces are disabled so request metadata and trace payloads are not retained. Sampling reduces stored volume but is not a spending cap; review Cloudflare usage and the configured monitor count before changing the rate.

## Release verification

Resolve and record the reviewed revision’s full immutable SHA immediately before building:

```sh
RELEASE_COMMIT="$(git rev-parse HEAD)"
git status --short
git show --no-patch --format='%H %s' "$RELEASE_COMMIT"
```

The worktree must be clean and the recorded SHA must match the revision that was reviewed and tested. Build one immutable artifact from `RELEASE_COMMIT`; do not rebuild from or deploy an earlier intermediate commit. If a staged rollout truly requires different code artifacts, stop and require each artifact to be rebuilt, independently reviewed, and fully verified before it receives its own approval.

### Local verification record

Run these checks with Node 22.13.0 or newer after checking out the recorded `RELEASE_COMMIT`:

```sh
npm ci
npm run check
npm run deploy:dry-run
npm audit --json
git diff --check
```

Record the actual runtime versions, test count and command results with the release. Historical test counts are not a gate for a newer revision. These are local results, not production evidence. See `repository-audit-2026-09-27.md` for the audit baseline and remediation verification.

### Production status

No production action was performed. No remote D1 inspection, export, migration, or Time Travel action was run. No Worker version was uploaded, deployed, promoted, or rolled back. No secret was read or rotated. No real monitor, cron, heartbeat, webhook, or notification was triggered. No production request, Cloudflare log search, observation window, or external health-monitor check was performed. Those steps require an approved production change window and remain open below.

### One-artifact production rollout checklist

- [ ] Preflight: use Node 22.13.0 or newer; check out the recorded `RELEASE_COMMIT`; require a clean worktree; re-run clean install, `npm run check`, `npm run deploy:dry-run`, the production dependency audit, and independent review. Record the current known-good Worker version, D1 information, recovery timestamp, and portable remote export.
- [ ] Migration gate: confirm every migration is forward-compatible with the recorded rollback version, then apply the reviewed remote migrations once. Stop on any unexpected schema or data result.
- [ ] Deploy the one reviewed artifact once and record its Worker version and artifact digest. Do not rebuild between the observation gates below.
- [ ] Observation gate 1 — status and security, at least 30 minutes: verify log redaction, sampled application-log availability, stale/unknown API and UI behavior, badge 404 behavior, protected assets, security headers, `/api/health`, API errors, and configured monitor states.
- [ ] Observation gate 2 — scheduler and delivery, at least two additional hours: verify isolated probe failures, Outbox pending/delivery behavior, notification deduplication, and external heartbeat delivery. Continue only if gate 1 remained clean.
- [ ] Observation gate 3 — presentation and accessibility: verify all five languages, incident history, timezone/DST display, keyboard and reduced-motion behavior, and the external dead-man's-switch monitor. Continue only if gates 1 and 2 remained clean.
- [ ] Production acceptance: trigger one approved test monitor through DOWN, grace, and UP; confirm exactly one down event key and one recovery event key. Stop cron long enough to confirm `Monitoring delayed` after 181 seconds, then restore cron and confirm healthy status within one run. Review any retained sampled application events for the documented allowlisted schema; the absence of a sampled event is inconclusive and must not be treated as proof of redaction.

### Rollback criteria and response

Stop the active batch and begin rollback review if any of these occurs: `/api/health` returns 503 continuously for three minutes; all monitors become `unknown` together; Outbox pending count grows for five consecutive dispatch rounds; or API 5xx exceeds 1% during the observation window. Also stop for credential or response-body disclosure, an authentication bypass, loss of stored state, or repeated notification event keys.

For a Worker-only regression with compatible data, roll back to the recorded known-good Worker version and repeat health and data checks. A Worker rollback does not revert D1 or Durable Object state. Do not reverse or restore D1 automatically; if schema/data compatibility is uncertain, stop traffic-changing work and choose an approved forward-compatible hotfix or the separately reviewed D1 recovery procedure using the recorded export or Time Travel point.


## Probe and confirmed-status behavior

HTTP probes follow at most five redirects within one total timeout. Same-origin redirects preserve configured headers. Cross-origin redirects are allowed only for requests with no body and only public `Accept`, `Accept-Language` or `User-Agent` headers. Requests carrying any other header are rejected at that boundary; HTTPS-to-HTTP redirects and URL userinfo are rejected. Configure the final URL directly for authenticated endpoints that redirect across origins. Webhook redirects are rejected, including same-origin redirects, so a 3xx cannot forward notification credentials or payloads or mark an event delivered.

TCP targets must include a port from 1 to 65535 (`host:443`, `[2001:db8::1]:443`). Globalping TCP fractional RTT is rounded to integer milliseconds for storage. Truncated Globalping content returns an inconclusive result unless the returned prefix already proves the configured keyword result.

`failureThreshold` counts consecutive failed monitoring runs, after any per-run retries. Candidate counts survive scheduler restarts; a successful probe clears the candidate. Once the threshold is met, the incident starts at that confirming check and the notification grace period begins there. Page summaries, badges, incident history, uptime calculations, callbacks and outbox events all use the confirmed incident. A successful probe resolves it immediately. Existing open incidents remain confirmed during upgrades; historical incidents are not rewritten. Raw latency samples still include unsuccessful candidate probes.

## State storage and upgrade compatibility

The Worker keeps the v2 logical state and reads existing inline v1/v2 records. Values above 512,000 UTF-8 bytes are saved losslessly as a small `state` manifest and JSON-encoded `state:chunk:*` rows in the existing `uptimeflare` table. Each encoded chunk remains below the D1 2,000,000-byte row limit, even for Unicode. This needs no new SQL migration. All state chunks, manifest updates and outbox changes use one D1 batch; readers retrieve manifest and chunks from one SQL snapshot. Missing or malformed chunks fail closed instead of silently resetting state. Shrinking back to inline state deletes obsolete chunks in the same transaction.

Deploy this code before large state approaches the row limit. Once a chunk manifest has been written, older Workers that only understand inline state cannot read it: rollback must use a version with chunk support, or an explicitly planned export/conversion after verifying that the complete state fits an inline row. Do not delete chunks or discard pending notification state to make an old version start. D1 exports include all chunks; a direct SELECT of the `state` key alone is no longer a complete backup.

Chunking removes the single-row ceiling; aggregate CPU, memory, response size and database capacity still scale with retained history. Review these separately before substantially increasing monitor count or retention. The 90-day retention and pending-event protection are unchanged.
