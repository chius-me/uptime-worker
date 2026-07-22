# Task 1 report: redact secrets and validate runtime config

## Implementation

- Added `resolveConfigValue`, which recursively resolves `<SECRET_NAME>` placeholders in strings, arrays, and objects. Empty, null, and undefined values fail closed with the configuration path.
- Added `validateAndResolveConfig`, which resolves the complete worker config before scheduled work begins, then validates unique monitor IDs, 1–30000 ms monitor/webhook timeouts, allowed proxy schemes (`http`, `https`, `worker`, `globalping`), and HTTPS webhook URLs.
- The scheduled handler now passes the resolved configuration to probes, callbacks, notification grace-period logic, and webhooks. The previous target-only resolver was removed.
- Added `logEvent` and replaced webhook output with hostname, method, status, and duration only. Webhook non-2xx and network failures now reject with a fixed `Error`.
- Removed webhook finalized-parameter/response-body output, Globalping request/result/raw-output output, response-body keyword output, and interpolated runtime error logging. Error logs now use fixed categories.

## Files changed

- `src/config.ts` (new)
- `src/log.ts` (new)
- `src/util.ts`
- `src/monitor.ts`
- `src/index.ts`
- `types/config.ts`
- `tests/config.test.ts` (new)
- `tests/logging.test.ts` (new)

## TDD evidence

### RED

Command:

```sh
npx vitest run tests/config.test.ts tests/logging.test.ts
```

Relevant output:

```text
FAIL tests/config.test.ts
Error: Cannot find module '../src/config'

FAIL tests/logging.test.ts > webhook logging > never logs webhook credentials or body
Expected: host=api.telegram.org
Received: ... "private message" ... bot-token ... chat-id ... Authorization ...
```

The tests failed because the resolver module did not yet exist and the prior webhook logger emitted the private message, credential-bearing URL, authorization header, and payload.

### GREEN

Command:

```sh
npx vitest run tests/config.test.ts tests/logging.test.ts && npx tsc --noEmit
```

Relevant output:

```text
Test Files  2 passed (2)
Tests  6 passed (6)
```

## Final verification

Command:

```sh
npx vitest run tests/config.test.ts tests/logging.test.ts && npx vitest run && npx tsc --noEmit && git diff --check
```

Output:

```text
Test Files  2 passed (2)
Tests  6 passed (6)

Test Files  4 passed (4)
Tests  10 passed (10)
```

`npx tsc --noEmit` and `git diff --check` completed successfully without output.

## Self-review

- Confirmed unresolved placeholders cause the scheduled handler to stop before its location fetch or monitor probes.
- Confirmed nested webhook header/body values are resolved recursively and are never printed by the webhook logger.
- Confirmed non-2xx webhook responses are logged without a body and propagate a fixed error.
- Confirmed runtime proxy and Globalping logging no longer includes configured endpoints, payloads, response bodies, raw output, or caught exception text.
- Confirmed all scheduled monitoring and notification reads use the resolved configuration rather than the imported raw config.

## Concerns

- The deployment release gate remains operational: rotate the Telegram Bot Token after deployment, and revoke the old token before subsequent phases if Cloudflare Logs retained prior leaked values.

## Follow-up: safe monitor IDs before interpolation

Review identified that monitor IDs are logged and were previously included in the generic recursive resolver. A placeholder in an ID could therefore be resolved to a secret before reaching structured logs.

- Added raw pre-resolution monitor ID validation using the documented safe opaque pattern `^[A-Za-z0-9_-]{1,64}$`.
- Placeholder IDs and unsafe IDs (slashes, whitespace, empty IDs, and IDs longer than 64 characters) now fail with `Invalid monitor id at monitors[index].id` before recursive resolution.
- Kept duplicate-ID validation after resolution as required.

### Follow-up RED

Command:

```sh
npx vitest run tests/config.test.ts tests/logging.test.ts
```

Relevant output:

```text
Test Files  1 failed | 1 passed (2)
Tests  5 failed | 6 passed (11)

rejects placeholder monitor ids before their secret values can be resolved
expected [Function] to throw an error

rejects unsafe monitor id "api/service"
rejects unsafe monitor id "api id"
rejects unsafe monitor id ""
rejects unsafe monitor id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

### Follow-up GREEN and typecheck

Command:

```sh
npx vitest run tests/config.test.ts tests/logging.test.ts && npx tsc --noEmit
```

Output:

```text
Test Files  2 passed (2)
Tests  11 passed (11)
```

`npx tsc --noEmit` completed successfully without output.

### Recorded minor review note

`webhookNotify` retains its unused `_env` parameter because the Task 1 brief explicitly requires the existing `webhookNotify(env, ...)` interface. It is intentionally deferred rather than changing that interface in this containment fix.
