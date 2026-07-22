import { describe, expect, it } from 'vitest'
import {
  filterNotificationEvents,
  transitionMonitor,
  type MonitorTransitionState,
} from '../src/state-machine'
import { failedProbe, successfulProbe } from '../src/probe'

const empty = (monitorId = 'api'): MonitorTransitionState => ({
  monitorId,
  incident: null,
})

describe('incident state machine', () => {
  it('queues down once when grace elapses without marking it delivered', () => {
    const first = transitionMonitor(empty(), failedProbe('Timeout: deadline exceeded'), 100, 120)
    expect(first.events).toEqual([])
    expect(first.incident).toMatchObject({
      id: 'api:100',
      startedAt: 100,
      resolvedAt: null,
      downEventKey: null,
      downNotifiedAt: null,
    })

    const grace = transitionMonitor(first.state, failedProbe('Timeout: deadline exceeded'), 220, 120)
    expect(grace.events.map(({ eventKey }) => eventKey)).toEqual(['api:100:down'])
    expect(grace.incident).toMatchObject({
      downEventKey: 'api:100:down',
      downNotifiedAt: null,
    })

    const replay = transitionMonitor(grace.state, failedProbe('Timeout: deadline exceeded'), 221, 120)
    expect(replay.events).toEqual([])
    expect(replay.state).toEqual(grace.state)
  })

  it('records changed diagnostics without re-queuing down', () => {
    const down = transitionMonitor(empty(), failedProbe('Timeout: deadline exceeded'), 100, 0)
    const changed = transitionMonitor(
      down.state,
      failedProbe('Unexpected status: expected 200, got 503'),
      110,
      0
    )

    expect(changed.events).toEqual([])
    expect(changed.incident?.changes).toEqual([
      { at: 100, internalError: 'Timeout: deadline exceeded', publicMessage: 'Timeout' },
      {
        at: 110,
        internalError: 'Unexpected status: expected 200, got 503',
        publicMessage: 'Unexpected status code',
      },
    ])
  })

  it('resolves before grace without queuing recovery', () => {
    const down = transitionMonitor(empty(), failedProbe('Timeout: deadline exceeded'), 100, 120)
    const recovered = transitionMonitor(down.state, successfulProbe(42), 110, 120)

    expect(recovered.events).toEqual([])
    expect(recovered.incident).toMatchObject({
      resolvedAt: 110,
      downEventKey: null,
      recoveryEventKey: null,
      recoveryNotifiedAt: null,
    })
  })

  it('queues recovery when a down event was queued, even if it is not delivered yet', () => {
    const down = transitionMonitor(empty(), failedProbe('Timeout: deadline exceeded'), 100, 0)
    const recovered = transitionMonitor(down.state, successfulProbe(42), 130, 0)

    expect(recovered.events).toEqual([
      {
        eventKey: 'api:100:recovery',
        incidentId: 'api:100',
        monitorId: 'api',
        kind: 'recovery',
        payload: {
          startedAt: 100,
          checkedAt: 130,
          publicMessage: 'OK',
        },
      },
    ])
    expect(recovered.incident).toMatchObject({
      downEventKey: 'api:100:down',
      downNotifiedAt: null,
      recoveryEventKey: 'api:100:recovery',
      recoveryNotifiedAt: null,
    })

    const replay = transitionMonitor(recovered.state, successfulProbe(43), 131, 0)
    expect(replay.events).toEqual([])
    expect(replay.state).toEqual(recovered.state)
  })

  it('starts a deterministic new incident after a resolved incident', () => {
    const first = transitionMonitor(empty(), failedProbe('Timeout: deadline exceeded'), 100, 0)
    const recovered = transitionMonitor(first.state, successfulProbe(42), 110, 0)
    const second = transitionMonitor(
      recovered.state,
      failedProbe('Connection: refused'),
      120,
      60
    )

    expect(second.incident).toMatchObject({ id: 'api:120', startedAt: 120, resolvedAt: null })
    expect(second.events).toEqual([])
  })

  it('filters maintenance and skip-list events without changing the transition', () => {
    const transitioned = transitionMonitor(empty(), failedProbe('Connection: refused'), 100, 0)

    expect(filterNotificationEvents(transitioned.events, {
      maintenanceMonitorIds: ['api'],
    })).toEqual([])
    expect(filterNotificationEvents(transitioned.events, {
      skipNotificationIds: ['api'],
    })).toEqual([])
    expect(transitioned.incident).toMatchObject({
      id: 'api:100',
      resolvedAt: null,
      downEventKey: 'api:100:down',
    })
  })
})
