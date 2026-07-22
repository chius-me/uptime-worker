import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

import worker from '../src/index'
import { workerConfig } from '../uptime.config'

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const originalPasswordProtection = workerConfig.passwordProtection

function envWithAssets(fetchAsset: (request: Request) => Promise<Response>) {
  return {
    ASSETS: { fetch: fetchAsset },
    UPTIME_WORKER_D1: {
      prepare: () => ({ bind: () => ({ first: async () => undefined }) }),
    },
  } as any
}

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  for (const [name, value] of Object.entries(securityHeaders)) {
    expect(response.headers.get(name)).toContain(value)
  }
}

afterEach(() => {
  workerConfig.passwordProtection = originalPasswordProtection
})

describe('worker security boundary', () => {
  it('configures Static Assets to invoke the Worker first and use SPA fallbacks', async () => {
    const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')

    expect(config).toMatch(/run_worker_first\s*=\s*true/)
    expect(config).toMatch(/not_found_handling\s*=\s*"single-page-application"/)
  })

  it('requires Basic Auth before requesting protected static assets', async () => {
    workerConfig.passwordProtection = 'admin:secret'
    let assetRequests = 0

    const env = envWithAssets(async () => {
        assetRequests++
        return new Response('asset')
      })
    const index = await worker.fetch(new Request('https://status.example.test/index.html'), env, ctx)
    const css = await worker.fetch(new Request('https://status.example.test/css/style.css'), env, ctx)

    expect(index.status).toBe(401)
    expect(css.status).toBe(401)
    expect(assetRequests).toBe(0)
    expectSecurityHeaders(index)
    expectSecurityHeaders(css)
  })

  it('adds security headers to every API endpoint, API error, and preflight response', async () => {
    workerConfig.passwordProtection = undefined
    const env = envWithAssets(async () => new Response('asset'))
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => undefined } },
    })

    try {
      const data = await worker.fetch(new Request('https://status.example.test/api/data'), env, ctx)
      const apiError = await worker.fetch(new Request('https://status.example.test/api/badge'), env, ctx)
      const health = await worker.fetch(new Request('https://status.example.test/api/health'), env, ctx)
      const preflight = await worker.fetch(new Request('https://status.example.test/api/data', { method: 'OPTIONS' }), env, ctx)

      expect(apiError.status).toBe(400)
      for (const response of [data, apiError, health, preflight]) {
        expectSecurityHeaders(response)
      }
    } finally {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
      else Reflect.deleteProperty(globalThis, 'caches')
    }
  })

  it('returns secured 503 responses for corrupt state on every state-reading API route', async () => {
    workerConfig.passwordProtection = undefined
    const corrupt = JSON.stringify({
      schemaVersion: 2,
      lastUpdate: 1_000,
      lastRun: 1_000,
      overallUp: 1,
      overallDown: 0,
      monitoringStartedAt: {},
      incident: {},
      latency: { blog: { loc: { v: ['SFO'], c: [2] }, ping: '2a00', time: 'e8030000' } },
    })
    const env = {
      ...envWithAssets(async () => new Response('asset')),
      UPTIME_WORKER_D1: {
        prepare: () => ({ bind: () => ({ first: async () => ({ value: corrupt }) }) }),
      },
    } as any
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => undefined } },
    })

    try {
      const responses = await Promise.all([
        worker.fetch(new Request('https://status.example.test/api/data'), env, ctx),
        worker.fetch(new Request('https://status.example.test/api/badge?id=blog'), env, ctx),
        worker.fetch(new Request('https://status.example.test/api/health'), env, ctx),
      ])

      for (const response of responses) {
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expectSecurityHeaders(response)
        await expect(response.json()).resolves.toEqual({ error: 'State unavailable' })
      }
    } finally {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
      else Reflect.deleteProperty(globalThis, 'caches')
    }
  })

  it('returns secured no-store 503 responses for an empty stored state string', async () => {
    workerConfig.passwordProtection = undefined
    const env = {
      ...envWithAssets(async () => new Response('asset')),
      UPTIME_WORKER_D1: {
        prepare: () => ({ bind: () => ({ first: async () => ({ value: '' }) }) }),
      },
    } as any
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => undefined } },
    })

    try {
      const responses = await Promise.all([
        worker.fetch(new Request('https://status.example.test/api/data'), env, ctx),
        worker.fetch(new Request('https://status.example.test/api/badge?id=blog'), env, ctx),
        worker.fetch(new Request('https://status.example.test/api/health'), env, ctx),
      ])
      for (const response of responses) {
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expectSecurityHeaders(response)
        await expect(response.json()).resolves.toEqual({ error: 'State unavailable' })
      }
    } finally {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
      else Reflect.deleteProperty(globalThis, 'caches')
    }
  })

  it('projects a migrated v1 dummy as a filtered monitoring baseline, not an incident', async () => {
    workerConfig.passwordProtection = undefined
    const checkedAt = Math.round(Date.now() / 1000)
    const baseline = checkedAt - 90 * 24 * 60 * 60
    const legacy = JSON.stringify({
      lastUpdate: checkedAt,
      overallUp: 1,
      overallDown: 0,
      incident: {
        blog: { start: [[baseline]], end: [baseline], error: [['dummy']] },
        removed: { start: [[baseline]], end: [baseline], error: [['dummy']] },
      },
      latency: {
        blog: { loc: { v: ['SFO'], c: [1] }, ping: '2a00', time: 'e8030000' },
      },
    })
    const env = {
      ...envWithAssets(async () => new Response('asset')),
      UPTIME_WORKER_D1: {
        prepare: () => ({ bind: () => ({ first: async () => ({ value: legacy }) }) }),
      },
    } as any
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: { match: async () => undefined, put: async () => undefined } },
    })

    try {
      const response = await worker.fetch(new Request('https://status.example.test/api/data'), env, ctx)
      const payload = await response.json() as any
      const serialized = JSON.stringify(payload)

      expect(response.status).toBe(200)
      expect(payload.state.monitoringStartedAt).toEqual({ blog: baseline })
      expect(payload.state.incident.blog).toEqual([])
      expect(payload.state.monitoringStartedAt.removed).toBeUndefined()
      expect(payload.monitors.blog).toMatchObject({ up: true, message: 'OK' })
      expect(serialized).not.toContain('dummy')
      expect(serialized).not.toContain('Connection failed')
    } finally {
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
      else Reflect.deleteProperty(globalThis, 'caches')
    }
  })

  it('adds security headers to static assets and explicit SPA fallbacks', async () => {
    workerConfig.passwordProtection = undefined
    const requestedPaths: string[] = []
    const env = envWithAssets(async (request) => {
        requestedPaths.push(new URL(request.url).pathname)
        if (new URL(request.url).pathname === '/dashboard') return new Response('missing', { status: 404 })
        if (new URL(request.url).pathname === '/index.html') {
          return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })
        }
        return new Response('body {}', {
          headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=60' },
        })
      })
    const directAsset = await worker.fetch(new Request('https://status.example.test/css/style.css'), env, ctx)
    const fallback = await worker.fetch(new Request('https://status.example.test/dashboard'), env, ctx)

    expect(requestedPaths).toEqual(['/css/style.css', '/dashboard', '/index.html'])
    expect(directAsset.headers.get('content-type')).toBe('text/css')
    expect(directAsset.headers.get('cache-control')).toBe('public, max-age=60')
    expect(fallback.status).toBe(200)
    expect(fallback.headers.get('content-type')).toBe('text/html')
    expectSecurityHeaders(directAsset)
    expectSecurityHeaders(fallback)
  })

  it('does not rely on inline event handlers for upcoming maintenance', async () => {
    const app = await readFile(new URL('../static/js/app.js', import.meta.url), 'utf8')

    expect(app).not.toMatch(/onclick\s*=/)
    expect(app).not.toMatch(/window\.UW/)
    expect(app).toContain("addEventListener('click'")
  })
})
