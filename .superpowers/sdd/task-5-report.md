# Task 5 report: versioned incident state machine and v1-to-v2 migration

## Scope delivered

- Added a pure, deterministic incident state machine in `src/state-machine.ts`.
  - Incident IDs are `${monitorId}:${startedAt}`.
  - Down and recovery event keys are `${incidentId}:down` and `${incidentId}:recovery`.
  - Grace-period replay, error changes, recovery gating, and resolved-to-new-incident transitions are idempotent.
  - Event generation sets queued keys only. `downNotifiedAt` and `recoveryNotifiedAt` remain delivery-confirmation fields.
  - Maintenance and skip-list policy is a separate pure event filter and does not mutate the incident transition.
- Added the v2 incident, change, notification, and compacted-state contracts in `types/config.ts`.
- Reworked `CompactedMonitorStateWrapper` to transparently migrate legacy compacted and row-oriented v1 states, validate v2 states, and always serialize schema v2.
  - Legacy dummy incidents become `monitoringStartedAt` and are absent from serialized v2 incident history.
  - V1 incidents receive deterministic IDs and classified public messages; migration does not synthesize queued or delivered notification state.
  - Latency hex alignment/content, RLE columns/count totals, and all incident column lengths are validated eagerly and fail with `CorruptStateError`.
  - Existing legacy incident and latency methods remain available. A virtual dummy marker preserves the current scheduler's indexing/pruning behavior, while legacy `setIncident` preserves v2 event metadata.
- Added narrow corruption handling for `/api/data`, `/api/badge`, and `/api/health`.
  - Only `CorruptStateError` maps to HTTP 503.
  - The response body is fixed to `{ "error": "State unavailable" }`, is `no-store`, retains JSON/CORS headers, and receives Task 7 security headers at the Worker boundary.
  - Unrelated store/programmer errors continue to propagate.

## TDD evidence

### RED 1: state machine and migration

Command:

```sh
npx vitest run tests/state-machine.test.ts tests/store.test.ts
```

Observed:

- `tests/state-machine.test.ts` failed to load because `src/state-machine.ts` did not exist.
- Store tests reported 7 expected failures: no schema upgrade, v2 legacy adapter incompatibility, and no strict rejection for invalid hex, RLE, or incident columns.

### GREEN 1

Command:

```sh
npx vitest run tests/state-machine.test.ts tests/store.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       14 passed (14)
```

### RED 2: explicit API corruption boundary

Command:

```sh
npx vitest run tests/api.test.ts tests/security.test.ts
```

Observed two expected failures: invalid latency hex and inconsistent RLE counts propagated as `CorruptStateError` instead of returning 503. The unrelated-error propagation test already passed.

### GREEN 2

Command:

```sh
npx vitest run tests/api.test.ts tests/security.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       26 passed (26)
```

## Final verification

Command:

```sh
npx vitest run tests/state-machine.test.ts tests/store.test.ts tests/api.test.ts tests/security.test.ts && npm test && npx tsc --noEmit && git diff --check
```

Result:

```text
Focused: 4 test files passed, 40 tests passed
Full:    11 test files passed, 79 tests passed
TypeScript: exit 0
git diff --check: exit 0
```

## Self-review

- Confirmed `src/state-machine.ts` has no clock reads, network calls, webhook calls, or mutation of the input state.
- Confirmed queued event keys and delivery timestamps are never conflated.
- Confirmed recovery is queued only when a down event key exists; delivery ordering remains Task 6 dispatcher responsibility.
- Confirmed all legacy mutators operate over v2 columns and retain notification metadata on updates.
- Confirmed v1 dummy data is removed from serialized incident columns while the intermediate scheduler still sees its required legacy marker.
- Confirmed corrupt-state catches are type-narrow and do not affect asset routes or mask unrelated failures.
- Confirmed no Scheduler DO, D1 outbox, SQL migration, or orchestration rewrite was introduced.

## Concerns

None for Task 5. Task 6 still needs to set `lastRun`, activate v2 transitions in the scheduled orchestrator, persist delivery confirmations, and enforce down-delivered-before-recovery dispatch ordering.

## Review remediation: public baseline and empty-state corruption

### Scope

- Removed synthetic/migrated dummy incidents from the API incident projection and monitor summaries.
- Added a public `state.monitoringStartedAt` map, filtered to configured monitor IDs, so the non-incident monitoring baseline remains available without fabricating a `Connection failed` incident.
- Kept the virtual dummy exclusively in the wrapper's legacy `incidentLen`/`getIncident`/mutation view used by the intermediate scheduled code.
- Changed D1 reads to preserve an empty stored string and changed the wrapper to treat only `null` as absence. Empty strings now fail JSON parsing as `CorruptStateError` and map to the same secured, non-cacheable 503 on data, badge, and health APIs.
- Added explicit row-oriented v1 migration coverage and frozen-input transition coverage for both error changes and recovery.

### RED

Command:

```sh
npx vitest run tests/state-machine.test.ts tests/store.test.ts tests/api.test.ts tests/security.test.ts
```

Result:

```text
Test Files  2 failed | 2 passed (4)
Tests       3 failed | 42 passed (45)
```

Expected failures:

- `getFromStore` collapsed `''` to `null`.
- Empty stored state therefore returned HTTP 200 instead of the corruption 503.
- Migrated v1 dummy state had no public `monitoringStartedAt` baseline and still flowed through the legacy incident projection.

The new row-oriented migration and frozen-input immutability tests passed in this RED run, confirming the existing implementation while closing the missing confidence coverage.

### GREEN

Command:

```sh
npx vitest run tests/state-machine.test.ts tests/store.test.ts tests/api.test.ts tests/security.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests       45 passed (45)
```

### Full verification

Command:

```sh
npx tsc --noEmit && npm test && git diff --check
```

Result:

```text
TypeScript: exit 0
Full: 11 test files passed, 84 tests passed
git diff --check: exit 0
```

### Review-remediation self-review

- Confirmed dummy detection happens before both summary selection and public incident adaptation, so `dummy` cannot be classified as a public connection failure.
- Confirmed a fresh latency sample with no real incident represents a healthy monitor, while missing latency and stale data remain unknown.
- Confirmed baseline projection merges migrated v2 metadata with legacy dummy timing and filters removed monitor IDs.
- Confirmed `uncompact()` carries `monitoringStartedAt` separately and no longer synthesizes dummy rows; only the legacy wrapper index methods retain the virtual marker.
- Confirmed the empty-string 503 response has the fixed body, `no-store`, JSON/CORS headers, and Task 7 security headers on all three API routes.
- Confirmed frozen input includes the incident, changes array, and change objects; error-change and recovery transitions operate on copies.
