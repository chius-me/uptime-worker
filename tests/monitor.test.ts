import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MonitorTarget } from '../types/config'
import { getStatus, getStatusWithGlobalPing } from '../src/monitor'
import { getWorkerLocation } from '../src/util'

const tcpMonitor: MonitorTarget = {
  id: 'tcp',
  name: 'TCP',
  method: 'TCP_PING',
  target: 'service.example:443',
  timeout: 5,
}

describe('bounded monitor probes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('closes a TCP socket after open timeout', async () => {
    vi.useFakeTimers()
    const socket = {
      opened: new Promise<never>(() => undefined),
      close: vi.fn(async () => undefined),
    }

    const pending = getStatus(tcpMonitor, { connect: () => socket })
    await vi.advanceTimersByTimeAsync(5)

    await expect(pending).resolves.toMatchObject({ up: false, publicMessage: 'Timeout' })
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('bounds HTTP keyword response reads and cancels the stream', async () => {
    const cancel = vi.fn(async () => undefined)
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array(65_537).fill(97) }),
      cancel,
      releaseLock: vi.fn(),
    }
    const response = {
      status: 200,
      body: { getReader: () => reader, cancel: vi.fn() },
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await getStatus({
      id: 'http', name: 'HTTP', method: 'GET', target: 'https://service.example',
      responseKeyword: 'needle', timeout: 100,
    })

    expect(result).toMatchObject({ up: false, publicMessage: 'Content check inconclusive' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('times out and cancels an HTTP body that stalls after headers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    let requestSignal: AbortSignal | null | undefined
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<never>(() => undefined),
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal
      return new Response(stream, { status: 200 })
    }))

    const pending = getStatus({
      id: 'http-stall', name: 'HTTP stall', method: 'GET', target: 'https://service.example',
      responseKeyword: 'needle', timeout: 20,
    })
    const settled = vi.fn()
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(20)

    expect(settled).toHaveBeenCalledOnce()
    await expect(pending).resolves.toMatchObject({
      ping: 20, up: false, publicMessage: 'Timeout',
    })
    expect(requestSignal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns unknown when the worker location request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('trace unavailable') }))
    await expect(getWorkerLocation()).resolves.toBe('unknown')
  })

  it('returns unknown when the worker location body stalls after headers', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<never>(() => undefined),
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const pending = getWorkerLocation()
    const settled = vi.fn()
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(3000)

    expect(settled).toHaveBeenCalledOnce()
    await expect(pending).resolves.toBe('unknown')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns a canonical failure for empty Globalping results', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'measurement-1' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'finished', results: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })))

    await expect(getStatusWithGlobalPing({
      id: 'gp', name: 'GP', method: 'GET', target: 'https://service.example',
      checkProxy: 'globalping://token', timeout: 100,
    })).resolves.toEqual({
      location: 'ERROR',
      status: expect.objectContaining({ up: false, publicMessage: 'Connection failed' }),
    })
  })

  it.each([1.5, 65_536])('rejects Globalping latency outside Uint16 storage bounds: %s', async (ping) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'measurement-1' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'finished',
        results: [{
          probe: { country: 'US', city: 'San Jose' },
          result: { status: 'finished', timings: { total: ping }, statusCode: 200, tls: { authorized: true } },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(getStatusWithGlobalPing({
      id: 'gp', name: 'GP', method: 'GET', target: 'https://service.example',
      checkProxy: 'globalping://token', timeout: 100,
    })).resolves.toMatchObject({
      location: 'ERROR', status: { up: false, publicMessage: 'Connection failed' },
    })
  })

  it('accepts the Uint16 upper bound from Globalping', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'measurement-1' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'finished',
        results: [{
          probe: { country: 'US', city: 'San Jose' },
          result: { status: 'finished', timings: { total: 65_535 }, statusCode: 200, tls: { authorized: true } },
        }],
      }), { status: 200 })))

    await expect(getStatusWithGlobalPing({
      id: 'gp', name: 'GP', method: 'GET', target: 'https://service.example',
      checkProxy: 'globalping://token', timeout: 100,
    })).resolves.toMatchObject({
      location: 'US/San Jose', status: { ping: 65_535, up: true, publicMessage: 'OK' },
    })
  })
})
