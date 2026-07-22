import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MonitorTarget } from '../types/config'
import { doMonitor, remoteCheckerName } from '../src/monitor'
import { parseProxyResult } from '../src/probe'

const secretMonitor: MonitorTarget = {
  id: 'api',
  name: 'API',
  method: 'GET',
  target: 'https://service.example',
  timeout: 5000,
  expectedCodes: [200],
  responseKeyword: 'ok',
  headers: { Authorization: 'Bearer secret' },
  body: 'secret body',
  checkProxy: 'https://proxy.example/check',
  checkProxyAllowedHosts: ['proxy.example'],
  forwardHeaders: ['authorization'],
}

const env = { REMOTE_CHECKER_DO: {} } as Parameters<typeof doMonitor>[2]

describe('custom and Durable Object proxies', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sends only the non-secret proxy DTO', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      location: 'SJC',
      status: { ping: 12, up: true, internalError: '', publicMessage: 'OK' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(doMonitor(secretMonitor, 'SJC', env)).resolves.toBeDefined()
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      method: 'GET', target: 'https://service.example', timeout: 5000,
      expectedCodes: [200], responseKeyword: 'ok',
    })
    expect(fetchMock.mock.calls[0][1]!.body).not.toContain('Authorization')
    expect(fetchMock.mock.calls[0][1]!.body).not.toContain('secret body')
  })

  it('rejects an unlisted custom proxy host without fetching it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await doMonitor({ ...secretMonitor, checkProxyAllowedHosts: ['other.example'] }, 'SJC', env)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'api', status: { up: false, publicMessage: 'Connection failed' } })
  })

  it('rejects invalid proxy JSON with a canonical result carrying the monitor id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', {
      status: 200, headers: { 'content-type': 'application/json' },
    })))

    await expect(doMonitor(secretMonitor, 'SJC', env)).resolves.toMatchObject({
      id: 'api', status: { up: false, publicMessage: 'Connection failed' },
    })
  })

  it('strictly validates proxy result fields', () => {
    for (const ping of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65_536]) {
      expect(() => parseProxyResult({
        location: 'SJC',
        status: { ping, up: true, internalError: '', publicMessage: 'OK' },
      })).toThrow()
    }
    expect(() => parseProxyResult({
      location: 'x'.repeat(257),
      status: { ping: 1, up: true, internalError: '', publicMessage: 'OK' },
    })).toThrow()
    expect(parseProxyResult({
      location: 'SJC',
      status: { ping: 65_535, up: true, internalError: '', publicMessage: 'OK' },
    }).status.ping).toBe(65_535)
  })

  it('requires the claimed public category to match the internal diagnostic', () => {
    expect(() => parseProxyResult({
      location: 'SJC',
      status: { ping: 1, up: false, internalError: 'deadline exceeded', publicMessage: 'Timeout' },
    })).toThrow()
    expect(parseProxyResult({
      location: 'SJC',
      status: { ping: 1, up: false, internalError: 'Timeout: deadline exceeded', publicMessage: 'Timeout' },
    }).status.publicMessage).toBe('Timeout')
    expect(() => parseProxyResult({
      location: 'SJC',
      status: { ping: 1, up: false, internalError: 'Connection: upstream timeout detail', publicMessage: 'Timeout' },
    })).toThrow()
    expect(parseProxyResult({
      location: 'SJC',
      status: { ping: 1, up: false, internalError: 'Connection: upstream timeout detail', publicMessage: 'Connection failed' },
    }).status.publicMessage).toBe('Connection failed')
  })

  it('does not follow a redirect away from an allowlisted custom proxy', async () => {
    const accepted = JSON.stringify({
      location: 'SJC',
      status: { ping: 12, up: true, internalError: '', publicMessage: 'OK' },
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === 'manual') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/check' } })
      }
      return new Response(accepted, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await doMonitor(secretMonitor, 'SJC', env)

    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
    expect(result).toMatchObject({ id: 'api', status: { up: false, publicMessage: 'Connection failed' } })
  })

  it('includes region in the Durable Object name', () => {
    expect(remoteCheckerName('api', 'apac')).toBe('api:apac')
  })

  it('uses the region-specific Durable Object and returns a canonical exception result', async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId)
    const get = vi.fn(() => ({
      getLocationAndStatus: vi.fn(async () => { throw new Error('private remote failure') }),
    }))
    const workerEnv = { REMOTE_CHECKER_DO: { idFromName, get } } as unknown as Parameters<typeof doMonitor>[2]

    const result = await doMonitor({
      id: 'api', name: 'API', method: 'GET', target: 'https://service.example',
      checkProxy: 'worker://apac', timeout: 20,
    }, 'SJC', workerEnv)

    expect(idFromName).toHaveBeenCalledWith('api:apac')
    expect(result).toMatchObject({ id: 'api', status: { up: false, publicMessage: 'Connection failed' } })
  })

  it('bounds a Durable Object call by the monitor timeout', async () => {
    vi.useFakeTimers()
    const workerEnv = {
      REMOTE_CHECKER_DO: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => ({ getLocationAndStatus: () => new Promise<never>(() => undefined) })),
      },
    } as unknown as Parameters<typeof doMonitor>[2]

    const pending = doMonitor({
      id: 'api', name: 'API', method: 'GET', target: 'https://service.example',
      checkProxy: 'worker://apac', timeout: 20,
    }, 'SJC', workerEnv)
    await vi.advanceTimersByTimeAsync(20)

    await expect(pending).resolves.toMatchObject({
      id: 'api', status: { ping: 20, up: false, publicMessage: 'Timeout' },
    })
  })
})
