import { describe, expect, it } from 'vitest'
import { buildDataPayload, handleBadgeAPI, handleHealthAPI, publicMessage, toPublicIncident } from '../src/api'
import type { MonitorState } from '../types/config'

const monitor = (id: string) => ({ id, name: id, method: 'GET', target: `https://${id}.example` })
const page = { title: 'Status' }

const emptyState: MonitorState = {
  lastUpdate: 0,
  overallUp: 0,
  overallDown: 0,
  incident: {},
  latency: {},
}

function stateAt(lastUpdate: number): MonitorState {
  return {
    ...emptyState,
    lastUpdate,
    overallUp: 1,
    incident: { api: [{ start: [900], end: 1000, error: ['dummy'] }] },
    latency: { api: [{ time: 1000, ping: 42, loc: 'SFO' }] },
  }
}

function stateWith(id: string, error: string): MonitorState {
  return {
    ...stateAt(1000),
    incident: { [id]: [{ start: [900], end: null, error: [error] }] },
  }
}

function envWithState(state: MonitorState) {
  return {
    UPTIME_WORKER_D1: {
      prepare: () => ({ bind: () => ({ first: async () => ({ value: JSON.stringify(state) }) }) }),
    },
  } as any
}

describe('public status API contracts', () => {
  it('returns a nullable summary for a configured monitor with no samples', () => {
    const payload = buildDataPayload(emptyState, [monitor('new')], page, 1_000)

    expect(payload.monitors.new).toEqual({
      up: null,
      latency: null,
      location: null,
      message: 'Not checked yet',
    })
    expect(payload.monitoringStatus).toBe('initializing')
  })

  it('marks data stale after 180 seconds and makes every monitor unknown', () => {
    const payload = buildDataPayload(stateAt(1_000), [monitor('api')], page, 1_181)

    expect(payload).toMatchObject({ stale: true, monitoringStatus: 'delayed' })
    expect(payload.monitors.api.up).toBeNull()
    expect(payload.monitors.api.latency).toBeNull()
    expect(payload.monitors.api.location).toBeNull()
  })

  it('does not expose removed monitor history or internal errors', () => {
    const payload = buildDataPayload(
      stateWith('old', 'getaddrinfo ENOTFOUND internal.lan'),
      [monitor('api')],
      page,
      1_010
    )

    expect(payload.state.incident.old).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain('internal.lan')
  })

  it('normalizes all public error messages', () => {
    expect(publicMessage('request timeout')).toBe('Timeout')
    expect(publicMessage('expected code 200, got 500')).toBe('Unexpected status code')
    expect(publicMessage('TLS certificate invalid')).toBe('TLS validation failed')
    expect(publicMessage('keyword was not found')).toBe('Content check failed')
    expect(publicMessage('getaddrinfo ENOTFOUND internal.lan')).toBe('Connection failed')
  })

  it('adapts legacy incidents without exposing their raw errors', () => {
    const incident = toPublicIncident('api', {
      start: [100, 110],
      end: null,
      error: ['getaddrinfo ENOTFOUND internal.lan', 'request timeout'],
    })

    expect(incident).toEqual({
      id: 'api:100',
      startedAt: 100,
      resolvedAt: null,
      changes: [
        { at: 100, publicMessage: 'Connection failed' },
        { at: 110, publicMessage: 'Timeout' },
      ],
      start: [100, 110],
      end: null,
      error: ['Connection failed', 'Timeout'],
    })
  })

  it('adapts v2 incidents while retaining only their public changes', () => {
    const incident = toPublicIncident('api', {
      id: 'incident-1',
      startedAt: 100,
      resolvedAt: 110,
      changes: [
        { at: 100, internalError: 'getaddrinfo ENOTFOUND internal.lan' },
        { at: 110, publicMessage: 'Timeout' },
      ],
    })

    expect(incident).toMatchObject({
      id: 'incident-1',
      startedAt: 100,
      resolvedAt: 110,
      changes: [
        { at: 100, publicMessage: 'Connection failed' },
        { at: 110, publicMessage: 'Timeout' },
      ],
      start: [100, 110],
      end: 110,
    })
    expect(JSON.stringify(incident)).not.toContain('internal.lan')
  })

  it('returns a 404 error badge for an unknown monitor', async () => {
    const response = await handleBadgeAPI(
      new Request('https://example.test/api/badge?id=missing'),
      envWithState(emptyState)
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: 'unknown-monitor', color: 'lightgrey' })
  })

  it('returns an unknown badge for a configured monitor with no data', async () => {
    const response = await handleBadgeAPI(
      new Request('https://example.test/api/badge?id=blog'),
      envWithState(emptyState)
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ message: 'unknown', color: 'lightgrey' })
  })

  it('returns an unknown badge when configured monitor data is stale', async () => {
    const response = await handleBadgeAPI(
      new Request('https://example.test/api/badge?id=blog'),
      envWithState({ ...stateAt(1_000), incident: { blog: [{ start: [900], end: 1_000, error: ['dummy'] }] } }),
      1_181
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ message: 'unknown', color: 'lightgrey' })
  })

  it('reports initializing and stale state as unhealthy', async () => {
    const initializing = await handleHealthAPI(envWithState(emptyState), 1_000)
    const stale = await handleHealthAPI(envWithState(stateAt(1_000)), 1_181)

    expect(initializing.status).toBe(503)
    await expect(initializing.json()).resolves.toEqual({ monitoringStatus: 'initializing', updatedAt: 0, stale: true })
    expect(stale.status).toBe(503)
    await expect(stale.json()).resolves.toEqual({ monitoringStatus: 'delayed', updatedAt: 1000, stale: true })
  })

  it('reports recent monitoring data as healthy', async () => {
    const health = await handleHealthAPI(envWithState(stateAt(1_000)), 1_180)

    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ monitoringStatus: 'healthy', updatedAt: 1000, stale: false })
  })
})
