import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url).toString())
const readmePath = `${root}README.md`
const operationsPath = `${root}docs/operations.md`

describe('deployment documentation', () => {
  it('documents the required README sections and safe proxy configuration', async () => {
    const [readme, config] = await Promise.all([
      readFile(readmePath, 'utf8'),
      readFile(`${root}uptime.config.ts`, 'utf8'),
    ])

    for (const heading of [
      'Architecture',
      'Quick start',
      'Secrets',
      'D1 migrations',
      'Monitoring the monitor',
      'Security and privacy',
    ]) {
      expect(readme).toContain(`## ${heading}`)
    }
    expect(readme).toContain('```mermaid')
    expect(readme).toContain('Node.js 22.13.0 or later')
    expect(readme).toContain('checkProxyAllowedHosts')
    expect(config).toContain('checkProxyAllowedHosts')
    expect(config).not.toMatch(/forwardHeaders:\s*\[[^\]]*(?:Authorization|Cookie)/i)
  })

  it('documents health freshness, delivery, and recovery operations', async () => {
    const operations = await readFile(operationsPath, 'utf8')

    expect(operations).toContain('/api/health')
    expect(operations).toContain('180 seconds')
    expect(operations).toContain('at-least-once')
    expect(operations).toContain('wrangler d1 migrations apply uptime_worker_d1 --remote')
    expect(operations).toContain("WHERE status = 'pending'")
    expect(operations).toContain('Absent state is `initializing`')
    expect(operations).toContain('Corrupt or unreadable state returns HTTP 503')
  })

  it('rolls out only the final reviewed immutable artifact', async () => {
    const operations = await readFile(operationsPath, 'utf8')

    expect(operations).not.toMatch(/3f90900|c55b055|0d2a6ec/)
    expect(operations).toContain('RELEASE_COMMIT="$(git rev-parse HEAD)"')
    expect(operations).toContain('one immutable artifact')
    expect(operations).toContain('No production action was performed')
    expect(operations).toContain('Deploy the one reviewed artifact once')
  })
})
