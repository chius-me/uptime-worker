# Uptime Worker Project Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unused configuration scaffolding and make password protection consistently cover every public endpoint without altering monitoring behavior.

**Architecture:** Keep the Worker entry point and its monitoring loop intact. Extract only the pure Basic Auth decision into a small dependency-free module so it can be tested using Node's built-in test runner; the Worker will apply that decision before API and asset routing.

**Tech Stack:** TypeScript 5, Cloudflare Workers, Node.js 22 built-in test runner, Wrangler 4.

## Global Constraints

- Preserve the existing D1 schema, monitor IDs, scheduled trigger, and public API response shapes.
- Do not expose webhook credentials or monitor targets in API responses.
- Require Node.js >=22; add no runtime dependency.

---

### Task 1: Add a testable authentication guard

**Files:**
- Create: `src/auth.ts`
- Create: `tests/auth.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `isBasicAuthValid(authorization: string | null, passwordProtection?: string): boolean`.
- Consumes: no Worker bindings; accepts the raw `Authorization` request header.

- [x] **Step 1: Write the failing test**

```js
test('accepts the configured Basic authorization value', async () => {
  assert.equal(isBasicAuthValid('Basic YWRtaW46c2VjcmV0', 'admin:secret'), true)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/auth.test.mjs`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Write minimal implementation**

```ts
export function isBasicAuthValid(authorization: string | null, passwordProtection?: string): boolean {
  if (!passwordProtection) return true
  return authorization === `Basic ${btoa(passwordProtection)}`
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/auth.test.mjs`

Expected: PASS for valid credentials, invalid credentials, and disabled protection.

### Task 2: Apply the guard uniformly and delete obsolete configuration

**Files:**
- Modify: `src/index.ts:24-76`
- Modify: `uptime.config.ts:1-88`
- Modify: `tsconfig.json:13`
- Delete: `uptime.config.full.ts`

**Interfaces:**
- Consumes: `isBasicAuthValid` from `src/auth.ts`.
- Preserves: `GET /api/data`, `GET /api/badge`, static asset and SPA fallback responses.

- [x] **Step 1: Write the failing test**

```js
test('rejects an absent authorization header when protection is configured', async () => {
  assert.equal(isBasicAuthValid(null, 'admin:secret'), false)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/auth.test.mjs`

Expected: FAIL before the guard implements missing-header rejection.

- [x] **Step 3: Write minimal implementation**

Move the existing Basic Auth check immediately after CORS preflight handling and before `/api/data`, `/api/badge`, and asset routing. Remove the full-example-only config file and update the remaining config's introductory comments and TypeScript include list.

- [x] **Step 4: Run tests and type checking**

Run: `npm test && npm exec tsc -- --noEmit`

Expected: all auth tests and TypeScript checks pass.

### Task 3: Verify deployment configuration and report residual risks

**Files:**
- Verify: `wrangler.toml`
- Verify: `.github/workflows/deploy.yml`
- Verify: `package-lock.json`

- [x] **Step 1: Run dependency audit**

Run: `npm audit --json --omit=dev --offline`

Expected: zero production dependency vulnerabilities in the available lockfile advisory data.

- [x] **Step 2: Run Worker dry-run build**

Run: `npx wrangler deploy --dry-run`

Expected: Worker bundle builds without publishing infrastructure changes.

- [x] **Step 3: Inspect final diff**

Run: `git diff --check && git diff --stat && git status --short`

Expected: only intentional source, test, configuration, and plan changes.
