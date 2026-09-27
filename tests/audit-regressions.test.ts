import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStatus, getStatusWithGlobalPing, parseTcpTarget } from '../src/monitor'
import { runMonitoring } from '../src/run-monitoring'
import { failedProbe, successfulProbe } from '../src/probe'
import { buildDataPayload, handleBadgeAPI } from '../src/api'
import { CompactedMonitorStateWrapper } from '../src/store'
import type { MonitorStateCompactedV2, WorkerConfig } from '../types/config'

const monitor = { id: 'homelab', name: 'test', method: 'TCP_PING', target: 'service.example:443', timeout: 100, failureThreshold: 2 }
const readEnv = (state: MonitorStateCompactedV2 | null) => ({ UPTIME_WORKER_D1: {
  prepare: () => ({ bind: () => ({
    first: async () => state === null ? null : { value: JSON.stringify(state) },
    all: async () => ({ results: [] }),
  }) }),
} }) as any

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('TCP address parsing', () => {
  it.each([
    ['service.example:22', 'service.example', 22],
    ['service.example:80', 'service.example', 80],
    ['service.example:443', 'service.example', 443],
    ['service.example:8443', 'service.example', 8443],
    ['[2001:db8::1]:443', '2001:db8::1', 443],
  ])('connects to the explicit port in %s', async (target, hostname, port) => {
    const connect = vi.fn((_address: { hostname: string; port: number }) => ({ opened: Promise.resolve(), close: async () => {} }))
    expect((await getStatus({ ...monitor, target }, { connect })).up).toBe(true)
    expect(connect).toHaveBeenCalledWith({ hostname, port })
  })
  it.each(['service.example', 'service.example:0', 'service.example:65536', 'service.example:abc', 'service.example:443/path', 'user:secret@service.example:443', '2001:db8::1:443'])('rejects malformed target %s', (target) => {
    expect(() => parseTcpTarget(target)).toThrow()
  })
})

function mockGlobalping(result: object) {
  const request = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'measurement' }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'finished', results: [{ probe: { country: 'US', city: 'New York' }, result }] })))
  vi.stubGlobal('fetch', request)
  return request
}

describe('Globalping contracts', () => {
  it.each([0, 0.49, 1.5, 65_534.9, 65_535])('rounds a valid fractional TCP RTT %s for storage', async (avg) => {
    const request = mockGlobalping({ status: 'finished', stats: { avg } })
    const result = await getStatusWithGlobalPing({ ...monitor, checkProxy: 'globalping://test' })
    expect(result.status).toMatchObject({ up: true, ping: Math.round(avg) })
    expect(JSON.parse(request.mock.calls[0][1].body).measurementOptions).toMatchObject({ port: 443, protocol: 'TCP' })
  })
  it.each([-1, 65_536, null, '1.5'])('rejects invalid TCP RTT %s', async (avg) => {
    mockGlobalping({ status: 'finished', stats: { avg } })
    expect((await getStatusWithGlobalPing({ ...monitor, checkProxy: 'globalping://test' })).status.up).toBe(false)
  })
  it.each([
    [{ responseForbiddenKeyword: 'error' }, 'safe prefix', 'Content check inconclusive'],
    [{ responseForbiddenKeyword: 'error' }, 'error in prefix', 'Content check failed'],
    [{ responseKeyword: 'ready' }, 'safe prefix', 'Content check inconclusive'],
    [{ responseKeyword: 'ready' }, 'ready prefix', 'OK'],
    [{ responseKeyword: 'ready', responseForbiddenKeyword: 'error' }, 'ready prefix', 'Content check inconclusive'],
    [{}, 'safe prefix', 'OK'],
  ])('handles truncated content checks %j', async (keywords, rawBody, publicMessage) => {
    mockGlobalping({ status: 'finished', timings: { total: 10 }, statusCode: 200, tls: { authorized: true }, rawBody, truncated: true })
    const result = await getStatusWithGlobalPing({ ...monitor, ...keywords, method: 'GET', target: 'https://service.example', checkProxy: 'globalping://test' })
    expect(result.status.publicMessage).toBe(publicMessage)
  })
})

describe('confirmed monitor status', () => {
  it('persists candidates across runs and keeps summary, badge, history and events consistent', async () => {
    const config: WorkerConfig = { monitors: [monitor], notification: { webhook: { url: 'https://hooks.example', payloadType: 'json', payload: { text: '$MSG' } } } }
    let state: MonitorStateCompactedV2 | null = null
    const run = async (up: boolean, at: number) => {
      const output = await runMonitoring(readEnv(state), config, at, `test-${at}`, {
        getWorkerLocation: async () => 'SFO', maintenances: [],
        doMonitor: async () => ({ id: monitor.id, location: 'SFO', status: up ? successfulProbe(1) : failedProbe('Timeout: test', 100) }),
      })
      state = new CompactedMonitorStateWrapper(JSON.stringify(output.state)).data
      const data = buildDataPayload(new CompactedMonitorStateWrapper(JSON.stringify(state)).uncompact(), config.monitors, {}, at)
      const badge = await handleBadgeAPI(new Request('https://status.example/api/badge?id=homelab'), readEnv(state), at)
      expect((await badge.json() as { message: string }).message).toBe(data.monitors.homelab.up ? 'UP' : 'DOWN')
      expect(output.state.overallDown).toBe(data.down)
      return { output, data }
    }
    const first = await run(false, 1000)
    expect(first.data.monitors.homelab.up).toBe(true)
    expect(first.data.state.incident.homelab).toEqual([])
    expect(first.output.events).toEqual([])
    expect(first.output.callbacks).toEqual([])
    expect(first.output.state.pendingFailures).toEqual({ homelab: 1 })
    await run(true, 1060) // A success resets the streak.
    expect((await run(false, 1120)).output.events).toEqual([])
    const confirmed = await run(false, 1180)
    expect(confirmed.output.events.map(({ kind }) => kind)).toEqual(['down'])
    expect(confirmed.data.monitors.homelab.up).toBe(false)
    expect(confirmed.data.state.incident.homelab[0].startedAt).toBe(1180)
    expect((await run(false, 1240)).output.events).toEqual([])
    const recovery = await run(true, 1300)
    expect(recovery.output.events.map(({ kind }) => kind)).toEqual(['recovery'])
    expect(recovery.data.monitors.homelab.up).toBe(true)
    expect((await run(false, 1360)).output.events).toEqual([])
  })
})
