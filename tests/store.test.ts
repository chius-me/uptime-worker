import { describe, expect, it } from 'vitest'
import { CompactedMonitorStateWrapper, CorruptStateError } from '../src/store'
import type { MonitorStateCompactedV2 } from '../types/config'

const legacyState = {
  lastUpdate: 220,
  overallUp: 0,
  overallDown: 1,
  incident: {
    api: {
      start: [[100], [200, 210]],
      end: [100, null],
      error: [['dummy'], ['Timeout: deadline exceeded', 'Connection: refused']],
    },
  },
  latency: {},
}

function v2State(): MonitorStateCompactedV2 {
  return {
    schemaVersion: 2,
    lastUpdate: 220,
    lastRun: 220,
    overallUp: 0,
    overallDown: 1,
    monitoringStartedAt: { api: 100 },
    incident: {
      api: {
        id: ['api:200'],
        startedAt: [200],
        resolvedAt: [null],
        changes: [[{
          at: 200,
          internalError: 'Timeout: deadline exceeded',
          publicMessage: 'Timeout',
        }]],
        downEventKey: ['api:200:down'],
        recoveryEventKey: [null],
        downNotifiedAt: [215],
        recoveryNotifiedAt: [null],
      },
    },
    latency: {
      api: {
        loc: { v: ['SFO'], c: [1] },
        ping: '2a00',
        time: 'dc000000',
      },
    },
  }
}

describe('versioned compacted state', () => {
  it('migrates v1 dummy history to monitoringStartedAt without creating an event-bearing incident', () => {
    const state = new CompactedMonitorStateWrapper(JSON.stringify(legacyState))

    expect(state.data).toMatchObject({
      schemaVersion: 2,
      lastRun: 220,
      monitoringStartedAt: { api: 100 },
    })
    expect(state.data.incident.api.id).toEqual(['api:200'])
    expect(state.data.incident.api.changes[0]).toEqual([
      { at: 200, internalError: 'Timeout: deadline exceeded', publicMessage: 'Timeout' },
      { at: 210, internalError: 'Connection: refused', publicMessage: 'Connection failed' },
    ])
    expect(state.data.incident.api.downEventKey).toEqual([null])
    expect(state.data.incident.api.downNotifiedAt).toEqual([null])
    const serialized = state.getCompactedStateStr()
    expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2 })
    expect(serialized).not.toContain('dummy')
  })

  it('round trips v2 state and preserves notification metadata through legacy updates', () => {
    const initial = new CompactedMonitorStateWrapper(JSON.stringify(v2State()))
    const legacy = initial.getIncident('api', 1)
    legacy.start.push(210)
    legacy.error.push('Connection: refused')
    legacy.end = 230
    initial.setIncident('api', 1, legacy)

    const restored = new CompactedMonitorStateWrapper(initial.getCompactedStateStr())
    expect(restored.data.incident.api).toMatchObject({
      id: ['api:200'],
      resolvedAt: [230],
      downEventKey: ['api:200:down'],
      downNotifiedAt: [215],
    })
    expect(restored.getIncident('api', 0)).toEqual({ start: [100], end: 100, error: ['dummy'] })
    expect(restored.getIncident('api', 1)).toEqual({
      start: [200, 210],
      end: 230,
      error: ['Timeout: deadline exceeded', 'Connection: refused'],
    })
    expect(restored.uncompact().latency.api).toEqual([{ time: 220, ping: 42, loc: 'SFO' }])
  })

  it('keeps legacy append, shift, and unshift behavior over v2 records', () => {
    const state = new CompactedMonitorStateWrapper(null)
    state.appendIncident('api', { start: [100], end: 100, error: ['dummy'] })
    state.appendIncident('api', { start: [200], end: null, error: ['Timeout: deadline exceeded'] })

    expect(state.incidentLen('api')).toBe(2)
    state.shiftIncident('api')
    expect(state.incidentLen('api')).toBe(1)
    expect(state.getIncident('api', 0).start).toEqual([200])
    state.unshiftIncident('api', { start: [90], end: 90, error: ['dummy'] })
    expect(state.getIncident('api', 0)).toEqual({ start: [90], end: 90, error: ['dummy'] })
  })

  it.each([
    ['non-hex latency', () => { const value = v2State(); value.latency.api.ping = 'zz00'; return value }],
    ['misaligned hex latency', () => { const value = v2State(); value.latency.api.time = '000'; return value }],
    ['RLE column mismatch', () => { const value = v2State(); value.latency.api.loc.c = []; return value }],
    ['RLE count total mismatch', () => { const value = v2State(); value.latency.api.loc.c = [2]; return value }],
    ['incident column mismatch', () => { const value = v2State(); value.incident.api.resolvedAt = []; return value }],
  ])('rejects %s', (_name, makeState) => {
    expect(() => new CompactedMonitorStateWrapper(JSON.stringify(makeState()))).toThrow(CorruptStateError)
  })
})
