# Task 2 report: stale-safe, null-safe public API contracts

## Scope delivered

- Added public status-contract builders, incident/error sanitization, badge handling, and health handling in `src/api.ts`.
- Changed `/api/data` to return an initializing 200 payload instead of a no-data 500, use nullable monitor summaries, filter removed monitor history, and mark data stale after 180 seconds.
- Added `/api/health`; healthy is 200 and initializing/delayed is 503.
- Made badge lookup safe: unknown monitor IDs are 404 error badges, and configured monitors with no data or stale data return `unknown`/`lightgrey`.
- Limited fresh `/api/data` shared caching to 30 seconds under the schema-versioned cache key. Initializing and stale payloads are `no-store`.
- Preserved sanitized v1 incident chart fields (`start`, `end`, `error`) while also exposing stable v2 public incident fields (`id`, `startedAt`, `resolvedAt`, `changes`).

## TDD evidence

### RED 1

Command:

```sh
npx vitest run tests/api.test.ts
```

Output:

```text
 RUN  v4.1.10 /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation

 ❯ tests/api.test.ts (0 test)

 FAIL  tests/api.test.ts [ tests/api.test.ts ]
Error: Cannot find module '../src/api' imported from /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation/tests/api.test.ts

 Test Files  1 failed (1)
      Tests  no tests
```

This failed because the required public API module did not exist.

### GREEN 1

Command:

```sh
npx vitest run tests/api.test.ts
```

Output:

```text
 RUN  v4.1.10 /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### RED 2

Command:

```sh
npx vitest run tests/api.test.ts && npm test && npx tsc --noEmit
```

Output:

```text
 RUN  v4.1.10 /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation

 ❯ tests/api.test.ts (11 tests | 1 failed)
     × returns an unknown badge when configured monitor data is stale

 FAIL  tests/api.test.ts > public status API contracts > returns an unknown badge when configured monitor data is stale
TypeError: Cannot read properties of undefined (reading 'length')
 ❯ CompactedMonitorStateWrapper.incidentLen src/store.ts:125:28
 ❯ handleBadgeAPI src/api.ts:215:41

 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```

The stale badge path unnecessarily accessed incident data before returning the stale `unknown` badge. The handler was changed to short-circuit on stale data first.

### GREEN 2 and final verification

Command:

```sh
npx vitest run tests/api.test.ts && npm test && npx tsc --noEmit
```

Output:

```text
 RUN  v4.1.10 /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation

 Test Files  1 passed (1)
      Tests  11 passed (11)

> uptime-worker@0.1.0 test
> vitest run

 RUN  v4.1.10 /Users/chius/repo/github/uptime-worker/.worktrees/codex-review-remediation

 Test Files  5 passed (5)
      Tests  26 passed (26)
```

`npx tsc --noEmit` completed with exit code 0 and no output.

## Files changed

- `src/api.ts` (new): public payload contracts, sanitized adapters, badge and health handlers.
- `src/index.ts`: public route wiring and stale-safe data caching.
- `types/config.ts`: public API contract types.
- `tests/api.test.ts` (new): API contract tests.
- `.superpowers/sdd/task-2-report.md` (new): TDD and verification evidence.

## Self-review

- Confirmed configured monitor IDs are the sole source for public incident and latency history.
- Confirmed raw legacy errors and v2 `internalError` do not enter public payloads; all legacy `error` values are `PublicMessage` categories.
- Confirmed no `getIncident(..., -1)` call remains on badge or data no-sample paths.
- Confirmed 180-second stale logic uses the required strict `> 180` threshold.
- Confirmed cache key carries schema version, fresh data is capped at `s-maxage=30`, and stale/initializing data is not stored.
- `git diff --check` passed.

## Concerns

None for this scope. The v1 compatibility fields are intentionally transitional and remain until the planned frontend migration.
