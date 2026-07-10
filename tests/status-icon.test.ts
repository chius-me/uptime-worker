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
