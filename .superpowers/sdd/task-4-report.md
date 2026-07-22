# Task 4 report — bounded and isolated probes

## Scope

Implemented the canonical `ProbeStatus` boundary and hardened HTTP, TCP, Globalping, Durable Object, worker-location, and custom HTTP(S) proxy probes. No production dependency was added. Task 5's schema state machine and Task 6's scheduler/all-settled/outbox work were not changed.

## TDD evidence

### RED

Command:

```text
npx vitest run tests/monitor.test.ts tests/proxy.test.ts
```

Initial result: exit 1. `tests/proxy.test.ts` could not import the not-yet-created `src/probe.ts`; all four initial monitor assertions failed. The failures demonstrated the missing canonical public status, TCP timeout cleanup, bounded HTTP content result, worker-location fallback, and Globalping empty-result category. The proxy suite also encoded the minimal DTO, allowlist, strict schema, invalid JSON, and region-aware DO requirements before production implementation.

### GREEN

Focused verification after implementation:

```text
Test Files  2 passed (2)
Tests       11 passed (11)
```

The focused tests cover TCP timeout cleanup, HTTP 64 KiB content bounds and stream cancellation, trace fallback, empty Globalping results, exact non-secret custom-proxy DTO, hostname rejection, malformed JSON, strict result validation, region-aware DO IDs, DO exceptions, and DO timeouts.

## Implementation

- Added `src/probe.ts` with the exact `ProbeStatus` shape, bounded text reading/cancellation, strict proxy result parsing, bounded diagnostic construction, and canonical success/failure helpers.
- Migrated local, Globalping, DO, and custom proxy probes to `ProbeStatus`. Internal diagnostics are bounded and stored, while notifications/callbacks consume fixed public categories; diagnostics are never logged.
- Closed TCP sockets in `finally`; fixed timeout timer and abort-listener cleanup; bounded and canceled HTTP response reads.
- Bounded worker-location lookup to 3 seconds and 4 KiB with fixed `unknown` fallback.
- Bounded Globalping create/poll fetches and JSON bodies, handled empty/malformed results, and limited Globalping logs to measurement ID, status, and duration.
- Keyed remote checkers by `<monitor id>:<region>`, bounded DO RPC duration, validated the returned shape, and removed `RemoteChecker.kill()` plus its call site.
- Custom proxy requests require an exact hostname allowlist, use the monitor timeout, require successful JSON responses, cap response bytes, and validate field types/ranges/lengths. Their JSON body is limited to `method`, `target`, `timeout`, `expectedCodes`, `responseKeyword`, and `responseForbiddenKeyword`; headers/body are not forwarded even when `forwardHeaders` is configured.
- Added `checkProxyAllowedHosts` and reserved `forwardHeaders` to `MonitorTarget`. `forwardHeaders` is intentionally inactive pending a future explicit forwarding design.

## Verification

Final verification commands:

```text
npx vitest run tests/monitor.test.ts tests/proxy.test.ts
npm test
npx tsc --noEmit
git diff --check
```

## Self-review

- Confirmed no legacy `status.err` production use remains.
- Confirmed no custom-proxy serialization of the monitor object, headers, or body remains.
- Confirmed every acquired response/socket has consumption or cancellation/close cleanup.
- Confirmed proxy/DO/Globalping failures resolve to a result carrying the monitor ID rather than rejecting `doMonitor`.
- Confirmed no scheduler `Promise.all`/outbox or storage state-machine changes were introduced.

## Concerns

Existing custom HTTP(S) proxy configurations now need `checkProxyAllowedHosts`; otherwise the probe returns the fixed `Connection failed` category (or uses the configured local fallback). This is the intended fail-closed behavior.
