# Final wave D report

Date: 2026-07-22

Branch: `codex/review-remediation`

Release identity: resolve `RELEASE_COMMIT="$(git rev-parse HEAD)"` from the clean, reviewed final head and record the full SHA in the release record. Historical intermediate commits are not approved artifacts.

## Implemented

- `/api/data` and `/api/health` now share `deriveMonitoringReadiness`: readiness requires at least one configured monitor and at least one persisted latency sample for every configured monitor. Fresh zero-monitor and newly configured unsampled states are `initializing`; stale state remains `delayed`; health returns 503 unless healthy.
- `/api/data` cache identity includes the ordered configured monitor IDs, preventing a pre-change healthy payload from masking a newly configured unsampled monitor.
- The status page treats empty configured-monitor and empty configured-group sets as unknown/initializing rather than operational.
- Uptime bars and aggregate percentages stop at the earlier of payload `updatedAt` and the monitor's latest sample time. Browser time still selects the visible local-calendar days; post-observation days render no data. Existing local-midnight, DST, and 90-day retention semantics remain covered.
- Wrangler observability is explicit: allowlisted application logs are enabled at 1% head sampling, invocation logs are disabled, and traces are disabled. The installed Wrangler 4.113.0 schema was inspected locally before configuration. Sampling reduces retained volume but is not a hard spending cap.
- README requires Node.js 22.13.0 or later. Operations now authorizes one final immutable artifact with sequential observation gates and contains no historical intermediate deployment pins. Production actions remain unperformed.

## TDD evidence

- Backend readiness RED: `npx vitest run tests/api.test.ts tests/worker.integration.test.ts` failed 5 of 43 tests for fresh zero-monitor and newly configured unsampled readiness. GREEN: the same focused command passed 43 of 43.
- Frontend readiness and observed-window RED: `npx vitest run tests/status-page.test.ts` failed 4 of 18 tests for empty overall/group green claims and multi-day stale healthy/open-incident accounting. GREEN: the same file passed 18 of 18, including DST and retention cases.
- Observability RED: focused security config regression failed because no observability block existed. GREEN: the focused regression passed.
- Release docs RED: `npx vitest run tests/docs.test.ts` failed for the imprecise Node floor and historical rollout pins. GREEN: 3 of 3 passed.
- Config-change lifecycle RED: the Worker integration test reused a cached healthy payload after adding a monitor. GREEN: the focused lifecycle test passed after cache-key versioning.

## Fresh local gates

- `npm run check`: exit 0; 17 test files, 201 tests passed; `tsc --noEmit` exit 0.
- `npm run deploy:dry-run`: exit 0; Wrangler 4.113.0; 19 assets; expected Durable Object, D1, and Assets bindings; no upload or deployment.
- `npm audit --omit=dev --json`: exit 0; 0 production vulnerabilities across all severities.
- `git diff --check`: exit 0.
- Runtime used for these local gates: Node.js 26.5.0 and npm 11.17.0. The declared release floor remains Node.js 22.13.0.

## Production boundary and remaining concerns

No production action was performed: no remote D1 operation, upload, deploy, promotion, rollback, secret change, live monitor transition, heartbeat, notification, production request, observation window, or Cloudflare log review. Those steps remain gated by the approved one-artifact checklist in `docs/operations.md`.

The 1% log sampling rate intentionally trades completeness for lower retention, privacy exposure, and cost; absence of an event is not proof that an operation did not occur. Production rollout must monitor usage and may change the rate only through a separately reviewed configuration change.
