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
