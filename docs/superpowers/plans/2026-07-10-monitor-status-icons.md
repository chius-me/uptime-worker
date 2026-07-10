# Monitor Status Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a colored line icon immediately before every monitor name.

**Architecture:** Keep the current API and monitor state model unchanged. Normalize the existing inline SVG wrappers in `renderMonitor` into a shared status-icon element; CSS assigns stable dimensions and state colors.

**Tech Stack:** Vanilla JavaScript, CSS custom properties, Vitest 4, Cloudflare Workers static assets.

## Global Constraints

- Preserve the Worker API and monitor state model.
- Render only a preceding icon: no text badge, error details, or tooltip.
- Use `--green`, `--red`, and `--gray` for the up, down, and no-data states.

---

### Task 1: Render the three monitor-state icons

**Files:**
- Create: `tests/status-icon.test.ts`
- Modify: `static/js/app.js:195-226`
- Modify: `static/css/style.css:368-383`

**Interfaces:**
- Consumes: `monData` from the existing `/api/data` response.
- Produces: `.monitor-status-icon.up`, `.monitor-status-icon.down`, and `.monitor-status-icon.unknown` before every monitor name.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('monitor status icon markup', () => {
  it('defines icons for up, down, and unknown states', async () => {
    const app = await readFile(new URL('../static/js/app.js', import.meta.url), 'utf8')
    expect(app).toContain('monitor-status-icon up')
    expect(app).toContain('monitor-status-icon down')
    expect(app).toContain('monitor-status-icon unknown')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/status-icon.test.ts`

Expected: FAIL because the renderer has no three state-specific classes.

- [ ] **Step 3: Write minimal implementation**

Add this helper directly before `renderMonitor` in `static/js/app.js`:

```js
function statusIcon(status) {
  const icon = status === 'down' ? ICONS.alert : ICONS.check
  return `<span class="monitor-status-icon ${status}">${icon}</span>`
}
```

Use `statusIcon('unknown')` in the no-data branch. In the data branch, use `statusIcon(isUp ? 'up' : 'down')` before the escaped name for both the linked and plain-name variants.

Add this CSS immediately after `.monitor-status-icon` in `static/css/style.css`:

```css
.monitor-status-icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
}
.monitor-status-icon svg { width: 100%; height: 100%; }
.monitor-status-icon.up { color: var(--green); }
.monitor-status-icon.down { color: var(--red); }
.monitor-status-icon.unknown { color: var(--gray); }
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/status-icon.test.ts`

Expected: 1 passing test.

- [ ] **Step 5: Run the complete verification suite**

Run: `npm test && npm exec tsc -- --noEmit && npx wrangler deploy --dry-run`

Expected: all tests and the TypeScript check pass; dry-run bundles the Worker and static assets without publishing.

- [ ] **Step 6: Commit**

```bash
git add tests/status-icon.test.ts static/js/app.js static/css/style.css docs/superpowers/plans/2026-07-10-monitor-status-icons.md
git commit -m "feat: show monitor status icons"
```
