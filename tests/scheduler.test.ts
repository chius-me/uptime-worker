import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

import type {
  MonitorStateCompactedV2,
  NotificationEvent,
  WorkerConfig,
} from '../types/config'
import worker from '../src/index'
import {
  Scheduler,
  dispatchPendingNotifications,
  invokeCallbackActions,
  sendHeartbeat,
  type SchedulerDependencies,
} from '../src/scheduler'
import type { RunOutput } from '../src/run-monitoring'
import { webhookNotify } from '../src/util'

const config: WorkerConfig = {
  monitors: [{ id: 'api', name: 'Current API name', method: 'GET', target: 'https://api.example' }],
  notification: {
    webhook: {
      url: 'https://hooks.example/token',
      payloadType: 'json',
      payload: { text: '$MSG' },
    },
  },
}

function stateWithIncident(): MonitorStateCompactedV2 {
  return {
    schemaVersion: 2,
    lastUpdate: 130,
    lastRun: 130,
    overallUp: 1,
    overallDown: 0,
    monitoringStartedAt: { api: 1 },
    incident: {
      api: {
        id: ['api:100'],
        startedAt: [100],
        resolvedAt: [130],
        changes: [[{
          at: 100,
          internalError: 'Connection: refused',
          publicMessage: 'Connection failed',
        }]],
        downEventKey: ['api:100:down'],
        recoveryEventKey: ['api:100:recovery'],
        downNotifiedAt: [null],
        recoveryNotifiedAt: [null],
      },
    },
    latency: {},
  }
}

function runOutput(): RunOutput {
  return {
    state: stateWithIncident(),
    events: [],
    callbacks: [],
    summary: {
      runId: 'run-fixed',
      scheduledAt: 1,
      completedAt: 2,
      total: 1,
      succeeded: 1,
      failed: 0,
      durationMs: 10,
    },
  }
}

function schedulerWith(overrides: Partial<SchedulerDependencies> = {}) {
  const dependencies: SchedulerDependencies = {
    resolveConfig: () => config,
    runMonitoring: vi.fn(async () => runOutput()),
    persistRun: vi.fn(async () => undefined),
    invokeCallbacks: vi.fn(async () => undefined),
    sendHeartbeat: vi.fn(async () => undefined),
    dispatchPendingNotifications: vi.fn(async () => ({ attempted: 0, delivered: 0, failed: 0 })),
    randomUUID: () => 'uuid',
    ...overrides,
  }
  return {
    scheduler: new Scheduler({} as DurableObjectState, {
      UPTIME_WORKER_D1: {},
      REMOTE_CHECKER_DO: {},
      ASSETS: {},
    } as any, dependencies),
    dependencies,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Scheduler', () => {
  it('coalesces overlapping scheduler calls', async () => {
    const release = deferred<RunOutput>()
    const runMonitoring = vi.fn(() => release.promise)
    const { scheduler } = schedulerWith({ runMonitoring })

    const first = scheduler.run(1_000)
    const second = await scheduler.run(1_001)

    expect(second).toEqual({ status: 'skipped-overlap', scheduledAt: 1_001 })
    release.resolve(runOutput())
    await first
    expect(runMonitoring).toHaveBeenCalledOnce()
  })

  it('does not perform callbacks, heartbeat, or delivery when atomic persistence fails', async () => {
    const persistRun = vi.fn(async () => { throw new Error('D1 unavailable') })
    const { scheduler, dependencies } = schedulerWith({ persistRun })

    await expect(scheduler.run(1_000)).rejects.toThrow('D1 unavailable')
    expect(dependencies.invokeCallbacks).not.toHaveBeenCalled()
    expect(dependencies.sendHeartbeat).not.toHaveBeenCalled()
    expect(dependencies.dispatchPendingNotifications).not.toHaveBeenCalled()
  })

  it('runs callbacks and heartbeat only after persistence and continues after heartbeat failure', async () => {
    const order: string[] = []
    const { scheduler } = schedulerWith({
      runMonitoring: vi.fn(async () => { order.push('run'); return runOutput() }),
      persistRun: vi.fn(async () => { order.push('persist') }),
      invokeCallbacks: vi.fn(async () => { order.push('callbacks') }),
      sendHeartbeat: vi.fn(async () => { order.push('heartbeat'); throw new Error('private heartbeat body') }),
      dispatchPendingNotifications: vi.fn(async () => {
        order.push('dispatch')
        return { attempted: 0, delivered: 0, failed: 0 }
      }),
    })

    await expect(scheduler.run(1_000)).resolves.toMatchObject({ status: 'completed' })
    expect(order).toEqual(['run', 'persist', 'callbacks', 'heartbeat', 'dispatch'])
  })

  it('delegates scheduled events to the singleton Durable Object', async () => {
    const run = vi.fn(async () => ({ status: 'completed' }))
    const idFromName = vi.fn(() => 'singleton-id')
    const get = vi.fn(() => ({ run }))

    await worker.scheduled(
      { scheduledTime: 123_000 } as ScheduledEvent,
      { SCHEDULER_DO: { idFromName, get } } as any,
      {} as ExecutionContext
    )

    expect(idFromName).toHaveBeenCalledWith('singleton')
    expect(get).toHaveBeenCalledWith('singleton-id')
    expect(run).toHaveBeenCalledWith(123_000)
  })
})

type StoredOutbox = {
  event_key: string
  payload: string
  status: 'pending' | 'delivered'
  attempts: number
  next_attempt_at: number
  delivered_at: number | null
  last_error_code: string | null
}

function outboxEvent(kind: NotificationEvent['kind']): StoredOutbox {
  return {
    event_key: `api:100:${kind}`,
    payload: JSON.stringify({
      eventKey: `api:100:${kind}`,
      incidentId: 'api:100',
      monitorId: 'api',
      kind,
      startedAt: 100,
      checkedAt: kind === 'down' ? 100 : 130,
      publicMessage: kind === 'down' ? 'Connection failed' : 'OK',
    }),
    status: 'pending',
    attempts: 0,
    next_attempt_at: 1_000,
    delivered_at: null,
    last_error_code: null,
  }
}

function dispatchEnv(
  rows: StoredOutbox[],
  options: { failConfirmation?: boolean } = {}
) {
  let state = stateWithIncident()
  const queries: string[] = []
  const failureUpdates: unknown[][] = []
  let confirmationAttempts = 0
  const db = {
    prepare(sql: string) {
      queries.push(sql)
      return {
        bind: (...args: unknown[]) => ({
          sql,
          args,
          async all() {
            return {
              results: rows.filter((row) => {
                if (row.status !== 'pending' || row.next_attempt_at > Number(args[0])) return false
                if (!row.event_key.endsWith(':recovery')) return true
                return rows.some((candidate) => (
                  candidate.event_key === `${JSON.parse(row.payload).incidentId}:down` &&
                  candidate.status === 'delivered'
                ))
              }).sort((left, right) => left.next_attempt_at - right.next_attempt_at || left.event_key.localeCompare(right.event_key)),
            }
          },
          async first() {
            if (sql.includes('FROM uptimeflare')) return { value: JSON.stringify(state) }
            return null
          },
          async run() {
            failureUpdates.push(args)
            const event = rows.find((row) => row.event_key === args[2])!
            event.attempts += 1
            event.next_attempt_at = Number(args[0])
            event.last_error_code = String(args[1])
            return { success: true }
          },
        }),
      }
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      confirmationAttempts += 1
      if (options.failConfirmation) throw new Error('confirmation unavailable')
      const outboxStatement = statements.find(({ sql }) => sql.includes('UPDATE notification_outbox'))!
      const stateStatement = statements.find(({ sql }) => sql.includes('INSERT INTO uptimeflare'))!
      const row = rows.find((candidate) => candidate.event_key === outboxStatement.args[1])!
      row.status = 'delivered'
      row.delivered_at = Number(outboxStatement.args[0])
      state = JSON.parse(String(stateStatement.args[1]))
      return []
    },
  }
  return {
    env: { UPTIME_WORKER_D1: db } as any,
    queries,
    failureUpdates,
    getState: () => state,
    getConfirmationAttempts: () => confirmationAttempts,
  }
}

describe('notification outbox dispatcher', () => {
  it('queries due rows deterministically and sends recovery only after down is delivered', async () => {
    const rows = [outboxEvent('recovery'), outboxEvent('down')]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async (
      _env: unknown,
      _webhook: unknown,
      _message: string,
      _idempotencyKey?: string
    ) => undefined)
    const dependencies = { now: () => 1_000, resolveConfig: () => config, webhookNotify: notify }

    await dispatchPendingNotifications(fake.env, 20, dependencies)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][2]).toContain('Current API name')
    expect(notify.mock.calls[0][3]).toBe('api:100:down')

    await dispatchPendingNotifications(fake.env, 20, dependencies)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][3]).toBe('api:100:recovery')
    expect(fake.queries.find((query) => query.includes('notification_outbox'))).toMatch(/ORDER BY/i)
  })

  it('uses exponential backoff with a fixed error code when delivery fails', async () => {
    const rows = [outboxEvent('down')]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async () => { throw new Error('secret provider response') })

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 })
    expect(rows[0]).toMatchObject({
      attempts: 1,
      next_attempt_at: 1_030,
      last_error_code: 'delivery_failed',
    })
    expect(JSON.stringify(fake.failureUpdates)).not.toContain('secret provider response')
  })

  it('acknowledges delivery and the matching state timestamp in one batch', async () => {
    const rows = [outboxEvent('down')]
    const fake = dispatchEnv(rows)

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: vi.fn(async () => undefined),
    })

    expect(summary).toEqual({ attempted: 1, delivered: 1, failed: 0 })
    expect(rows[0]).toMatchObject({ status: 'delivered', delivered_at: 1_000 })
    expect(fake.getState().incident.api.downNotifiedAt).toEqual([1_000])
    expect(fake.getConfirmationAttempts()).toBe(1)
  })

  it('leaves an event pending for an at-least-once retry when confirmation fails', async () => {
    const rows = [outboxEvent('down')]
    const fake = dispatchEnv(rows, { failConfirmation: true })
    const notify = vi.fn(async () => undefined)
    const dependencies = { now: () => 1_000, resolveConfig: () => config, webhookNotify: notify }

    await expect(dispatchPendingNotifications(fake.env, 20, dependencies)).resolves.toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
    })
    await dispatchPendingNotifications(fake.env, 20, dependencies)

    expect(notify).toHaveBeenCalledTimes(2)
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: 1_000 })
  })
})

describe('callback delivery', () => {
  it('passes only fixed public categories and isolates callback failures', async () => {
    const onStatusChange = vi.fn(async () => { throw new Error('callback secret') })
    const onIncident = vi.fn(async () => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const callbackConfig: WorkerConfig = {
      ...config,
      callbacks: { onStatusChange, onIncident },
    }

    await invokeCallbackActions({} as any, callbackConfig, [
      {
        type: 'status-change',
        monitorId: 'api',
        isUp: false,
        startedAt: 100,
        checkedAt: 110,
        publicMessage: 'Connection failed',
      },
      {
        type: 'incident',
        monitorId: 'api',
        startedAt: 100,
        checkedAt: 110,
        publicMessage: 'Connection failed',
      },
    ])

    expect(onStatusChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'api' }),
      false,
      100,
      110,
      'Connection failed'
    )
    expect(onIncident).toHaveBeenCalledOnce()
    expect(log.mock.calls.flat().join(' ')).not.toContain('callback secret')
    log.mockRestore()
  })
})

describe('external delivery safety', () => {
  it('adds an optional idempotency key to webhook requests', async () => {
    const originalFetch = globalThis.fetch
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('api:100:down')
      return new Response(null, { status: 204 })
    })
    globalThis.fetch = request as typeof fetch
    try {
      await webhookNotify({} as any, config.notification!.webhook!, 'public message', 'api:100:down')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(request).toHaveBeenCalledOnce()
  })

  it('rejects non-HTTPS heartbeat destinations without making a request or leaking the URL', async () => {
    const originalFetch = globalThis.fetch
    const request = vi.fn(async () => new Response('', { status: 204 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    globalThis.fetch = request as typeof fetch
    try {
      await expect(sendHeartbeat({ HEARTBEAT_URL: 'http://secret.example/private' } as any)).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      log.mockRestore()
    }
    expect(request).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret.example')
  })
})

describe('deployment schema', () => {
  it('keeps RemoteChecker v1 and adds a distinct sqlite Scheduler migration and idempotent D1 tables', async () => {
    const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')
    const initial = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8')
    const outbox = await readFile(new URL('../migrations/0002_notification_outbox.sql', import.meta.url), 'utf8')

    expect(wrangler).toMatch(/tag\s*=\s*"v1"[\s\S]*new_sqlite_classes\s*=\s*\["RemoteChecker"\]/)
    expect(wrangler).toMatch(/name\s*=\s*"SCHEDULER_DO"[\s\S]*class_name\s*=\s*"Scheduler"/)
    expect(wrangler).toMatch(/tag\s*=\s*"v2"[\s\S]*new_sqlite_classes\s*=\s*\["Scheduler"\]/)
    expect(initial).toMatch(/CREATE TABLE IF NOT EXISTS uptimeflare/i)
    expect(outbox).toMatch(/CREATE TABLE IF NOT EXISTS notification_outbox/i)
    expect(outbox).toMatch(/CREATE TABLE IF NOT EXISTS monitor_runs/i)
  })
})
