import { describe, expect, it, vi } from 'vitest'
import type {
  MonitorStateCompactedV2,
  MonitorTarget,
  NotificationEvent,
  WorkerConfig,
} from '../types/config'
import { failedProbe, successfulProbe } from '../src/probe'
import {
  applyNotificationSuppression,
  transitionMonitor,
} from '../src/state-machine'
import {
  persistRun,
  runMonitoring,
  type RunOutput,
} from '../src/run-monitoring'

const monitor = (id: string): MonitorTarget => ({
  id,
  name: id.toUpperCase(),
  method: 'GET',
  target: `https://${id}.example`,
})

const webhook = {
  url: 'https://hooks.example/secret-token',
  payloadType: 'json' as const,
  payload: { text: '$MSG', token: 'must-not-be-stored' },
}

function emptyState(): MonitorStateCompactedV2 {
  return {
    schemaVersion: 2,
    lastUpdate: 0,
    lastRun: 0,
    overallUp: 0,
    overallDown: 0,
    monitoringStartedAt: {},
    incident: {},
    latency: {},
  }
}

function readEnv(
  state: MonitorStateCompactedV2 | null = null,
  pendingEventKeys: readonly string[] = [],
  pendingQueryError?: Error
) {
  return {
    REMOTE_CHECKER_DO: {},
    UPTIME_WORKER_D1: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => state === null ? null : { value: JSON.stringify(state) }),
          all: vi.fn(async () => {
            if (pendingQueryError) throw pendingQueryError
            if (!sql.includes('notification_outbox')) return { results: [] }
            return { results: pendingEventKeys.map((event_key) => ({ event_key })) }
          }),
        })),
      })),
    },
    ASSETS: {},
  } as any
}

describe('runMonitoring', () => {
  it('persists successful monitor results when another probe rejects unexpectedly', async () => {
    const config: WorkerConfig = {
      monitors: [monitor('up'), monitor('throws')],
      notification: { webhook },
    }
    const probe = vi.fn(async (target: MonitorTarget) => {
      if (target.id === 'throws') throw new Error('secret upstream diagnostic')
      return { id: target.id, location: 'SFO', status: successfulProbe(42) }
    })

    const output = await runMonitoring(readEnv(), config, 1_000, 'run-1', {
      doMonitor: probe,
      getWorkerLocation: async () => 'SFO',
      nowMs: () => 1_000_250,
    })

    expect(output.summary).toMatchObject({
      runId: 'run-1',
      scheduledAt: 1_000,
      total: 2,
      succeeded: 1,
      failed: 1,
    })
    expect(output.state).toMatchObject({
      lastUpdate: 1_000,
      lastRun: 1_000,
      overallUp: 1,
      overallDown: 1,
    })
    expect(output.state.latency.up).toBeDefined()
    expect(output.state.latency.throws.loc.v).toEqual(['unknown'])
    expect(output.state.incident.throws.changes[0][0]).toEqual({
      at: 1_000,
      internalError: 'Connection: probe execution failed',
      publicMessage: 'Connection failed',
    })
    expect(JSON.stringify(output)).not.toContain('secret upstream diagnostic')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('limits probe concurrency to five', async () => {
    const config: WorkerConfig = {
      monitors: Array.from({ length: 8 }, (_, index) => monitor(`m${index}`)),
    }
    let active = 0
    let maximum = 0
    const releases: Array<() => void> = []
    const probe = vi.fn(async (target: MonitorTarget) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return { id: target.id, location: 'SFO', status: successfulProbe(1) }
    })

    const pending = runMonitoring(readEnv(), config, 1_000, 'run-limit', {
      doMonitor: probe,
      getWorkerLocation: async () => 'SFO',
    })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(5))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(8))
    releases.splice(0).forEach((release) => release())
    await pending

    expect(maximum).toBe(5)
  })

  it('queues a grace-period event once and does not recreate it on replay', async () => {
    const config: WorkerConfig = {
      monitors: [monitor('api')],
      notification: { gracePeriod: 2, webhook },
    }
    const dependencies = {
      doMonitor: async () => ({
        id: 'api',
        location: 'SFO',
        status: failedProbe('Timeout: deadline exceeded'),
      }),
      getWorkerLocation: async () => 'SFO',
    }

    const first = await runMonitoring(readEnv(), config, 100, 'run-1', dependencies)
    expect(first.events).toEqual([])
    expect(first.state.incident.api.downEventKey).toEqual([null])

    const grace = await runMonitoring(readEnv(first.state), config, 220, 'run-2', dependencies)
    expect(grace.events.map(({ eventKey }) => eventKey)).toEqual(['api:100:down'])
    expect(grace.state.incident.api.downEventKey).toEqual(['api:100:down'])

    const replay = await runMonitoring(readEnv(grace.state), config, 221, 'run-3', dependencies)
    expect(replay.events).toEqual([])
    expect(replay.state.incident.api.downEventKey).toEqual(['api:100:down'])
  })

  it.each([
    ['maintenance', { maintenanceMonitorIds: ['api'] }],
    ['skip list', { skipNotificationIds: ['api'] }],
    ['missing webhook', { notificationsEnabled: false }],
  ])('rolls back only a newly-created event key suppressed by %s', (_name, policy) => {
    const transitioned = transitionMonitor(
      { monitorId: 'api', incident: null },
      failedProbe('Connection: refused'),
      100,
      0
    )

    const suppressed = applyNotificationSuppression(transitioned, policy)
    expect(suppressed.events).toEqual([])
    expect(suppressed.incident?.downEventKey).toBeNull()
    expect(suppressed.state.incident?.downEventKey).toBeNull()

    const alreadyPersisted = applyNotificationSuppression({
      ...transitioned,
      events: [],
    }, policy)
    expect(alreadyPersisted.incident?.downEventKey).toBe('api:100:down')
  })

  it('allows a still-down monitor to queue after maintenance ends', async () => {
    const config: WorkerConfig = { monitors: [monitor('api')], notification: { webhook } }
    const dependencies = {
      doMonitor: async () => ({
        id: 'api',
        location: 'SFO',
        status: failedProbe('Connection: refused'),
      }),
      getWorkerLocation: async () => 'SFO',
      maintenances: [{ monitors: ['api'], body: 'planned', start: 0, end: 150 }],
    }

    const maintained = await runMonitoring(readEnv(), config, 100, 'run-1', dependencies)
    expect(maintained.events).toEqual([])
    expect(maintained.state.incident.api.downEventKey).toEqual([null])

    const after = await runMonitoring(readEnv(maintained.state), config, 200, 'run-2', dependencies)
    expect(after.events.map(({ eventKey }) => eventKey)).toEqual(['api:100:down'])
  })

  it('retains an incident older than 90 days while a queued notification is pending', async () => {
    const now = 100 + 91 * 24 * 60 * 60
    const state = emptyState()
    state.incident.api = {
      id: ['api:100'],
      startedAt: [100],
      resolvedAt: [200],
      changes: [[{
        at: 100,
        internalError: 'Connection: refused',
        publicMessage: 'Connection failed',
      }]],
      downEventKey: ['api:100:down'],
      recoveryEventKey: ['api:100:recovery'],
      downNotifiedAt: [150],
      recoveryNotifiedAt: [null],
    }

    const output = await runMonitoring(
      readEnv(state, ['api:100:recovery']),
      { monitors: [monitor('api')], notification: { webhook } },
      now,
      'run-aged',
      {
        doMonitor: async () => ({ id: 'api', location: 'SFO', status: successfulProbe(1) }),
        getWorkerLocation: async () => 'SFO',
      }
    )

    expect(output.state.incident.api.id).toEqual(['api:100'])
    expect(output.state.incident.api.recoveryNotifiedAt).toEqual([null])
  })

  it('prunes an aged incident when its queued key is no longer actually pending', async () => {
    const now = 100 + 91 * 24 * 60 * 60
    const state = emptyState()
    state.incident.api = {
      id: ['api:100'],
      startedAt: [100],
      resolvedAt: [200],
      changes: [[{
        at: 100,
        internalError: 'Connection: refused',
        publicMessage: 'Connection failed',
      }]],
      downEventKey: ['api:100:down'],
      recoveryEventKey: ['api:100:recovery'],
      downNotifiedAt: [null],
      recoveryNotifiedAt: [null],
    }

    const output = await runMonitoring(
      readEnv(state, []),
      { monitors: [monitor('api')], notification: { webhook } },
      now,
      'run-terminalized',
      {
        doMonitor: async () => ({ id: 'api', location: 'SFO', status: successfulProbe(1) }),
        getWorkerLocation: async () => 'SFO',
      }
    )

    expect(output.state.incident.api).toBeUndefined()
  })

  it('fails before probing when pending-key lookup fails', async () => {
    const probe = vi.fn(async () => ({ id: 'api', location: 'SFO', status: successfulProbe(1) }))

    await expect(runMonitoring(
      readEnv(emptyState(), [], new Error('pending lookup unavailable')),
      { monitors: [monitor('api')], notification: { webhook } },
      100,
      'run-lookup-failure',
      { doMonitor: probe, getWorkerLocation: async () => 'SFO' }
    )).rejects.toThrow('pending lookup unavailable')
    expect(probe).not.toHaveBeenCalled()
  })

  it('defensively suppresses notifications for an empty webhook array', async () => {
    const output = await runMonitoring(
      readEnv(),
      { monitors: [monitor('api')], notification: { webhook: [] } },
      100,
      'run-empty-webhook',
      {
        doMonitor: async () => ({
          id: 'api',
          location: 'SFO',
          status: failedProbe('Connection: refused'),
        }),
        getWorkerLocation: async () => 'SFO',
      }
    )

    expect(output.events).toEqual([])
    expect(output.state.incident.api.downEventKey).toEqual([null])
  })

  it('derives status-change callbacks from transitions and incident callbacks from every down check', async () => {
    const config: WorkerConfig = { monitors: [monitor('api')] }
    const down = await runMonitoring(readEnv(), config, 100, 'run-1', {
      doMonitor: async () => ({ id: 'api', location: 'SFO', status: failedProbe('Connection: refused') }),
      getWorkerLocation: async () => 'SFO',
    })
    expect(down.callbacks.map(({ type }) => type)).toEqual(['status-change', 'incident'])
    expect(down.callbacks[0]).toMatchObject({ isUp: false, publicMessage: 'Connection failed' })

    const stillDown = await runMonitoring(readEnv(down.state), config, 110, 'run-2', {
      doMonitor: async () => ({ id: 'api', location: 'SFO', status: failedProbe('Connection: refused') }),
      getWorkerLocation: async () => 'SFO',
    })
    expect(stillDown.callbacks.map(({ type }) => type)).toEqual(['incident'])

    const recovered = await runMonitoring(readEnv(stillDown.state), config, 120, 'run-3', {
      doMonitor: async () => ({ id: 'api', location: 'SFO', status: successfulProbe(5) }),
      getWorkerLocation: async () => 'SFO',
    })
    expect(recovered.callbacks).toEqual([expect.objectContaining({
      type: 'status-change',
      isUp: true,
      publicMessage: 'OK',
    })])
  })
})

describe('persistRun', () => {
  it('writes state, run summary, and secret-free unique outbox rows in one D1 batch', async () => {
    const prepared: Array<{ sql: string; args: unknown[] }> = []
    const batch = vi.fn(async (_statements: unknown[]) => [])
    const env = {
      UPTIME_WORKER_D1: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => {
            const statement = { sql, args }
            prepared.push(statement)
            return statement
          },
        }),
        batch,
      },
    } as any
    const event: NotificationEvent = {
      eventKey: 'api:100:down',
      incidentId: 'api:100',
      monitorId: 'api',
      kind: 'down',
      payload: { startedAt: 100, checkedAt: 100, publicMessage: 'Connection failed' },
    }
    const output: RunOutput = {
      state: emptyState(),
      events: [event, structuredClone(event)],
      callbacks: [],
      summary: {
        runId: 'run-1',
        scheduledAt: 100,
        completedAt: 101,
        total: 1,
        succeeded: 1,
        failed: 0,
        durationMs: 10,
      },
    }

    await persistRun(env, output)

    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0][0]).toHaveLength(4)
    expect(prepared[0].sql).toContain('ON CONFLICT(key) DO UPDATE')
    expect(prepared[1].sql).toContain('monitor_runs')
    expect(prepared[2].sql).toContain('ON CONFLICT(event_key) DO NOTHING')
    const payload = JSON.parse(String(prepared[2].args[1]))
    expect(payload).toEqual({
      eventKey: 'api:100:down',
      incidentId: 'api:100',
      monitorId: 'api',
      kind: 'down',
      startedAt: 100,
      checkedAt: 100,
      publicMessage: 'Connection failed',
    })
    expect(JSON.stringify(prepared)).not.toContain('hooks.example')
    expect(JSON.stringify(prepared)).not.toContain('must-not-be-stored')
  })
})
