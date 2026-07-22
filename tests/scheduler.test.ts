import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
import { runMonitoring, type RunOutput } from '../src/run-monitoring'
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
    cleanupRetention: vi.fn(async () => undefined),
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
    expect(dependencies.cleanupRetention).not.toHaveBeenCalled()
  })

  it('dispatches immediately after persistence and isolates later cleanup and heartbeat failures', async () => {
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
      cleanupRetention: vi.fn(async () => {
        order.push('cleanup')
        throw new Error('private cleanup diagnostic')
      }),
    })

    await expect(scheduler.run(1_000)).resolves.toMatchObject({ status: 'completed' })
    expect(order).toEqual(['run', 'persist', 'dispatch', 'cleanup', 'heartbeat', 'callbacks'])
  })

  it('clears the overlap lock after one five-second window for concurrent monitor callbacks', async () => {
    vi.useFakeTimers()
    try {
      let callbackCalls = 0
      const onStatusChange = vi.fn(() => {
        callbackCalls += 1
        return callbackCalls <= 2 ? new Promise(() => undefined) : Promise.resolve()
      })
      const callbackConfig: WorkerConfig = {
        ...config,
        monitors: [
          ...config.monitors,
          { id: 'web', name: 'Web', method: 'GET', target: 'https://web.example' },
        ],
        callbacks: { onStatusChange },
      }
      const output = runOutput()
      output.callbacks = ['api', 'web'].map((monitorId) => ({
        type: 'status-change' as const,
        monitorId,
        isUp: false,
        startedAt: 100,
        checkedAt: 110,
        publicMessage: 'Connection failed' as const,
      }))
      const dispatch = vi.fn(async () => ({ attempted: 0, delivered: 0, failed: 0 }))
      const { scheduler } = schedulerWith({
        resolveConfig: () => callbackConfig,
        runMonitoring: vi.fn(async () => output),
        invokeCallbacks: invokeCallbackActions,
        dispatchPendingNotifications: dispatch,
      })

      const first = scheduler.run(1_000)
      let firstSettled = false
      void first.then(() => { firstSettled = true })
      await vi.waitFor(() => expect(onStatusChange).toHaveBeenCalledTimes(2))
      expect(dispatch).toHaveBeenCalledOnce()
      await expect(scheduler.run(1_001)).resolves.toEqual({
        status: 'skipped-overlap',
        scheduledAt: 1_001,
      })

      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.resolve()
      expect(firstSettled).toBe(true)
      await expect(scheduler.run(2_000)).resolves.toMatchObject({ status: 'completed' })
      expect(onStatusChange).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
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

function outboxFor(
  startedAt: number,
  kind: NotificationEvent['kind'],
  nextAttemptAt = 1_000
): StoredOutbox {
  return {
    event_key: `api:${startedAt}:${kind}`,
    payload: JSON.stringify({
      eventKey: `api:${startedAt}:${kind}`,
      incidentId: `api:${startedAt}`,
      monitorId: 'api',
      kind,
      startedAt,
      checkedAt: kind === 'down' ? startedAt : startedAt + 30,
      publicMessage: kind === 'down' ? 'Connection failed' : 'OK',
    }),
    status: 'pending',
    attempts: 0,
    next_attempt_at: nextAttemptAt,
    delivered_at: null,
    last_error_code: null,
  }
}

function outboxEvent(kind: NotificationEvent['kind']): StoredOutbox {
  return outboxFor(100, kind)
}

function stateForOutbox(rows: readonly StoredOutbox[]): MonitorStateCompactedV2 {
  const state = stateWithIncident()
  state.incident.api = {
    id: [],
    startedAt: [],
    resolvedAt: [],
    changes: [],
    downEventKey: [],
    recoveryEventKey: [],
    downNotifiedAt: [],
    recoveryNotifiedAt: [],
  }
  const incidents = new Map<number, { down: boolean; recovery: boolean }>()
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload)
      if (payload.monitorId !== 'api' || !Number.isSafeInteger(payload.startedAt)) continue
      const current = incidents.get(payload.startedAt) ?? { down: false, recovery: false }
      if (payload.kind === 'down') current.down = true
      if (payload.kind === 'recovery') current.recovery = true
      incidents.set(payload.startedAt, current)
    } catch {
      // Poison rows intentionally have no trustworthy state identity.
    }
  }
  for (const [startedAt, queued] of [...incidents].sort(([left], [right]) => left - right)) {
    state.incident.api.id.push(`api:${startedAt}`)
    state.incident.api.startedAt.push(startedAt)
    state.incident.api.resolvedAt.push(queued.recovery ? startedAt + 30 : null)
    state.incident.api.changes.push([{
      at: startedAt,
      internalError: 'Connection: refused',
      publicMessage: 'Connection failed',
    }])
    state.incident.api.downEventKey.push(queued.down || queued.recovery ? `api:${startedAt}:down` : null)
    state.incident.api.recoveryEventKey.push(queued.recovery ? `api:${startedAt}:recovery` : null)
    state.incident.api.downNotifiedAt.push(null)
    state.incident.api.recoveryNotifiedAt.push(null)
  }
  return state
}

function dispatchEnv(
  rows: StoredOutbox[],
  options: { failConfirmation?: boolean; state?: MonitorStateCompactedV2 } = {}
) {
  let state = structuredClone(options.state ?? stateWithIncident())
  const queries: string[] = []
  const failureUpdates: unknown[][] = []
  const terminalUpdates: unknown[][] = []
  let confirmationAttempts = 0
  const db = {
    prepare(sql: string) {
      queries.push(sql)
      return {
        bind: (...args: unknown[]) => ({
          sql,
          args,
          async all() {
            if (sql.includes("WHERE status = 'pending'") && !sql.includes('AS candidate')) {
              return {
                results: rows
                  .filter((row) => row.status === 'pending')
                  .map(({ event_key }) => ({ event_key })),
              }
            }
            return {
              results: rows.filter((row) => {
                return row.status === 'pending' && row.next_attempt_at <= Number(args[0])
              }).sort((left, right) => left.next_attempt_at - right.next_attempt_at || left.event_key.localeCompare(right.event_key))
                .slice(0, Number(args[1])),
            }
          },
          async first() {
            if (sql.includes('FROM uptimeflare')) return { value: JSON.stringify(state) }
            if (sql.includes('SELECT status') && sql.includes('notification_outbox')) {
              const row = rows.find((candidate) => candidate.event_key === args[0])
              return row ? {
                status: row.status,
                last_error_code: row.last_error_code,
                next_attempt_at: row.next_attempt_at,
              } : null
            }
            return null
          },
          async run() {
            if (sql.includes('SET next_attempt_at = ?') && !sql.includes('attempts = attempts + 1')) {
              const event = rows.find((row) => row.event_key === args[1])!
              event.next_attempt_at = Number(args[0])
              return { success: true }
            }
            const event = rows.find((row) => row.event_key === args[2])!
            if (sql.includes("SET status = 'delivered'")) {
              terminalUpdates.push(args)
              event.status = 'delivered'
              event.delivered_at = Number(args[0])
              event.last_error_code = String(args[1])
            } else {
              failureUpdates.push(args)
              event.attempts += 1
              event.next_attempt_at = Number(args[0])
              event.last_error_code = String(args[1])
            }
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
      const terminal = outboxStatement.args.length === 3
      const row = rows.find((candidate) => (
        candidate.event_key === outboxStatement.args[terminal ? 2 : 1]
      ))!
      row.status = 'delivered'
      row.delivered_at = Number(outboxStatement.args[0])
      row.last_error_code = terminal ? String(outboxStatement.args[1]) : null
      state = JSON.parse(String(stateStatement.args[1]))
      return []
    },
  }
  return {
    env: { UPTIME_WORKER_D1: db } as any,
    queries,
    failureUpdates,
    terminalUpdates,
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

    await dispatchPendingNotifications(fake.env, 1, dependencies)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][2]).toContain('Current API name')
    expect(notify.mock.calls[0][3]).toBe('api:100:down')

    await dispatchPendingNotifications(fake.env, 20, dependencies)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][3]).toBe('api:100:recovery')
    const selection = fake.queries.find((query) => query.includes('FROM notification_outbox AS candidate'))!
    expect(selection).toMatch(/ORDER BY/i)
    expect(selection).not.toContain('json_extract')
  })

  it('scans past more than twenty deferred recoveries to deliver a later due down', async () => {
    const rows: StoredOutbox[] = []
    for (let startedAt = 100; startedAt < 125; startedAt += 1) {
      rows.push(outboxFor(startedAt, 'recovery', 1_000))
      rows.push(outboxFor(startedAt, 'down', 5_000))
    }
    const deliverable = outboxFor(999, 'down', 1_001)
    rows.push(deliverable)
    const fake = dispatchEnv(rows, { state: stateForOutbox(rows) })
    const notify = vi.fn(async (
      _env: unknown,
      _webhook: unknown,
      _message: string,
      _idempotencyKey?: string
    ) => undefined)

    await dispatchPendingNotifications(fake.env, 1, {
      now: () => 2_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][3]).toBe('api:999:down')
    for (const recovery of rows.filter(({ event_key }) => event_key.endsWith(':recovery'))) {
      expect(recovery).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: 5_000 })
    }
  })

  it('defers recovery to the natural backoff of its failed down dependency', async () => {
    const down = outboxEvent('down')
    const recovery = outboxEvent('recovery')
    const rows = [down, recovery]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async (
      _env: unknown,
      _webhook: unknown,
      _message: string,
      eventKey?: string
    ) => {
      if (eventKey?.endsWith(':down')) throw new Error('provider unavailable')
    })

    await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(down).toMatchObject({ attempts: 1, next_attempt_at: 1_030 })
    expect(recovery).toMatchObject({ attempts: 0, next_attempt_at: 1_030, status: 'pending' })
    expect(notify).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', undefined],
    ['terminalized', 'invalid_payload'],
  ])('terminalizes recovery with a %s down dependency and reconciles state', async (_name, errorCode) => {
    const recovery = outboxEvent('recovery')
    const rows = [recovery]
    if (errorCode) {
      const down = outboxEvent('down')
      down.status = 'delivered'
      down.delivered_at = 900
      down.last_error_code = errorCode
      rows.push(down)
    }
    const fake = dispatchEnv(rows, { state: stateForOutbox(rows) })
    const notify = vi.fn(async () => undefined)

    await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(recovery).toMatchObject({ status: 'delivered', last_error_code: 'blocked_dependency' })
    expect(fake.getState().incident.api.recoveryEventKey).toEqual([null])
    expect(notify).not.toHaveBeenCalled()
  })

  it('terminalizes malformed JSON without blocking a later valid event', async () => {
    const malformed = outboxEvent('down')
    malformed.event_key = 'poison-row'
    malformed.payload = '{not-json'
    const valid = outboxEvent('down')
    valid.next_attempt_at = 1_001
    const rows = [malformed, valid]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async (
      _env: unknown,
      _webhook: unknown,
      _message: string,
      _idempotencyKey?: string
    ) => undefined)

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 2_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(summary).toEqual({ attempted: 2, delivered: 1, failed: 1 })
    expect(malformed).toMatchObject({
      status: 'delivered',
      delivered_at: 2_000,
      last_error_code: 'invalid_payload',
    })
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][3]).toBe('api:100:down')
  })

  it('terminalizes recovery after its down row is terminalized invalid', async () => {
    const invalidDown = outboxEvent('down')
    invalidDown.payload = '{not-json'
    const recovery = outboxEvent('recovery')
    const rows = [invalidDown, recovery]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async () => undefined)

    await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(invalidDown).toMatchObject({ status: 'delivered', last_error_code: 'invalid_payload' })
    expect(recovery).toMatchObject({ status: 'delivered', last_error_code: 'blocked_dependency' })
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid kind', { kind: 'sideways' }],
    ['invalid incident relation', { eventKey: 'other:100:down', incidentId: 'other:100' }],
    ['non-OK recovery message', { kind: 'recovery', eventKey: 'api:100:recovery', publicMessage: 'Connection failed' }],
    ['OK down message', { publicMessage: 'OK' }],
  ])('terminalizes a valid JSON payload with %s before external delivery', async (_name, changes) => {
    const row = outboxEvent('down')
    const payload = { ...JSON.parse(row.payload), ...changes }
    row.event_key = String(payload.eventKey)
    row.payload = JSON.stringify(payload)
    const fake = dispatchEnv([row])
    const notify = vi.fn(async () => undefined)

    await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(row).toMatchObject({ status: 'delivered', last_error_code: 'invalid_payload' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('reconciles a safely-identifiable invalid recovery and permits next-run pruning', async () => {
    const now = 100 + 91 * 24 * 60 * 60
    const row = outboxEvent('recovery')
    row.payload = JSON.stringify({
      ...JSON.parse(row.payload),
      publicMessage: 'Connection failed',
    })
    const oldState = stateForOutbox([row])
    oldState.incident.api.resolvedAt[0] = 130
    const fake = dispatchEnv([row], { state: oldState })

    await dispatchPendingNotifications(fake.env, 20, {
      now: () => now,
      resolveConfig: () => config,
      webhookNotify: vi.fn(async () => undefined),
    })
    expect(row).toMatchObject({ status: 'delivered', last_error_code: 'invalid_payload' })

    const output = await runMonitoring(fake.env, config, now, 'run-after-poison', {
      doMonitor: async () => ({ id: 'api', location: 'SFO', status: {
        up: true,
        ping: 1,
        internalError: '',
        publicMessage: 'OK',
      } }),
      getWorkerLocation: async () => 'SFO',
    })
    expect(output.state.incident.api).toBeUndefined()
  })

  it('leaves a safely-identifiable poison event pending when reconciliation fails', async () => {
    const row = outboxEvent('down')
    row.payload = JSON.stringify({
      ...JSON.parse(row.payload),
      publicMessage: 'OK',
    })
    const fake = dispatchEnv([row], {
      failConfirmation: true,
      state: stateForOutbox([row]),
    })

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: vi.fn(async () => undefined),
    })

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 })
    expect(row).toMatchObject({ status: 'pending', delivered_at: null, last_error_code: null })
    expect(fake.getState().incident.api.downEventKey).toEqual(['api:100:down'])
    expect(fake.terminalUpdates).toEqual([])
  })

  it('terminalizes an orphaned event before webhook delivery', async () => {
    const row = outboxEvent('down')
    const orphanState = stateWithIncident()
    delete orphanState.incident.api
    const fake = dispatchEnv([row], { state: orphanState })
    const notify = vi.fn(async () => undefined)

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => config,
      webhookNotify: notify,
    })

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 })
    expect(row).toMatchObject({ status: 'delivered', last_error_code: 'orphaned_event' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not acknowledge a valid event when the webhook array is empty', async () => {
    const row = outboxEvent('down')
    const fake = dispatchEnv([row])

    const summary = await dispatchPendingNotifications(fake.env, 20, {
      now: () => 1_000,
      resolveConfig: () => ({ ...config, notification: { webhook: [] } }),
      webhookNotify: vi.fn(async () => undefined),
    })

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 })
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error_code: 'delivery_failed' })
  })

  it('uses exponential backoff with a fixed error code when delivery fails', async () => {
    const rows = [outboxEvent('down')]
    const fake = dispatchEnv(rows)
    const notify = vi.fn(async () => { throw new Error('secret provider response') })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    let summary
    let logOutput = ''
    try {
      summary = await dispatchPendingNotifications(fake.env, 20, {
        now: () => 1_000,
        resolveConfig: () => config,
        webhookNotify: notify,
      })
      logOutput = log.mock.calls.flat().join(' ')
    } finally {
      log.mockRestore()
    }

    expect(summary).toEqual({ attempted: 1, delivered: 0, failed: 1 })
    expect(rows[0]).toMatchObject({
      attempts: 1,
      next_attempt_at: 1_030,
      last_error_code: 'delivery_failed',
    })
    expect(JSON.stringify(fake.failureUpdates)).not.toContain('secret provider response')
    expect(logOutput).toContain('notification_delivery_failed')
    expect(logOutput).toContain('monitorId="api"')
    expect(logOutput).not.toContain('api:100:down')
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

  it('bounds each callback invocation to five seconds', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const never = vi.fn(() => new Promise(() => undefined))
      const pending = invokeCallbackActions({} as any, {
        ...config,
        callbacks: { onIncident: never },
      }, [{
        type: 'incident',
        monitorId: 'api',
        startedAt: 100,
        checkedAt: 110,
        publicMessage: 'Connection failed',
      }])
      let settled = false
      void pending.then(() => { settled = true })

      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(never).toHaveBeenCalledOnce()
      expect(log.mock.calls.flat().join(' ')).toContain('callback_failed')
    } finally {
      log.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('D1 retention cleanup', () => {
  it('deletes only bounded 90-day-old run summaries and delivered outbox rows', async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = []
    const batch = vi.fn(async () => [])
    const env = {
      UPTIME_WORKER_D1: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => {
            const statement = { sql, args }
            statements.push(statement)
            return statement
          },
        }),
        batch,
      },
    } as any
    const { cleanupD1Retention } = await import('../src/scheduler')

    await cleanupD1Retention(env, 100 + 90 * 24 * 60 * 60)

    expect(batch).toHaveBeenCalledOnce()
    expect(statements).toHaveLength(2)
    expect(statements[0].sql).toMatch(/DELETE FROM monitor_runs[\s\S]*LIMIT 1000/i)
    expect(statements[1].sql).toMatch(/DELETE FROM notification_outbox[\s\S]*status = 'delivered'[\s\S]*LIMIT 1000/i)
    expect(statements[1].sql).toMatch(/NOT EXISTS[\s\S]*status = 'pending'/i)
    expect(statements[0].args).toEqual([100])
    expect(statements[1].args).toEqual([100])
  })

  it('logs a fixed category and resolves when cleanup fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { cleanupD1Retention } = await import('../src/scheduler')
    let output = ''
    try {
      await expect(cleanupD1Retention({
        UPTIME_WORKER_D1: {
          prepare: () => ({ bind: () => ({}) }),
          batch: async () => { throw new Error('private database diagnostic') },
        },
      } as any, 10_000_000)).resolves.toBeUndefined()
      output = log.mock.calls.flat().join(' ')
    } finally {
      log.mockRestore()
    }
    expect(output).toContain('retention_cleanup_failed')
    expect(output).not.toContain('private database diagnostic')
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
    const wrangler = await readFile(fileURLToPath(String(new URL('../wrangler.toml', import.meta.url))), 'utf8')
    const initial = await readFile(fileURLToPath(String(new URL('../migrations/0001_initial.sql', import.meta.url))), 'utf8')
    const outbox = await readFile(fileURLToPath(String(new URL('../migrations/0002_notification_outbox.sql', import.meta.url))), 'utf8')

    expect(wrangler).toMatch(/tag\s*=\s*"v1"[\s\S]*new_sqlite_classes\s*=\s*\["RemoteChecker"\]/)
    expect(wrangler).toMatch(/name\s*=\s*"SCHEDULER_DO"[\s\S]*class_name\s*=\s*"Scheduler"/)
    expect(wrangler).toMatch(/tag\s*=\s*"v2"[\s\S]*new_sqlite_classes\s*=\s*\["Scheduler"\]/)
    expect(initial).toMatch(/CREATE TABLE IF NOT EXISTS uptimeflare/i)
    expect(outbox).toMatch(/CREATE TABLE IF NOT EXISTS notification_outbox/i)
    expect(outbox).toMatch(/CREATE TABLE IF NOT EXISTS monitor_runs/i)
    expect(outbox).toMatch(/CREATE INDEX IF NOT EXISTS notification_outbox_due[\s\S]*status\s*,\s*next_attempt_at\s*,\s*event_key/i)
    expect(outbox).toMatch(/CREATE INDEX IF NOT EXISTS notification_outbox_delivered[\s\S]*status\s*,\s*delivered_at\s*,\s*event_key/i)
    expect(outbox).toMatch(/CREATE INDEX IF NOT EXISTS monitor_runs_completed[\s\S]*completed_at\s*,\s*run_id/i)

    const compatibility = await readFile(fileURLToPath(String(new URL('../deploy/init.sql', import.meta.url))), 'utf8')
    expect(compatibility).toMatch(/CREATE INDEX IF NOT EXISTS notification_outbox_due/i)
    expect(compatibility).toMatch(/CREATE INDEX IF NOT EXISTS notification_outbox_delivered/i)
    expect(compatibility).toMatch(/CREATE INDEX IF NOT EXISTS monitor_runs_completed/i)
  })

  it('deploys D1 migrations and documents new and compatibility installs', async () => {
    const workflow = await readFile(fileURLToPath(String(new URL('../.github/workflows/deploy.yml', import.meta.url))), 'utf8')
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(String(new URL('../package.json', import.meta.url))), 'utf8')
    ) as { scripts: Record<string, string> }
    const readme = await readFile(fileURLToPath(String(new URL('../README.md', import.meta.url))), 'utf8')

    expect(workflow).toMatch(/npm run d1:migrate:remote/)
    expect(workflow).not.toMatch(/wrangler d1 execute[\s\S]*deploy\/init\.sql/)
    expect(packageJson.scripts['d1:migrate:local']).toBe(
      'wrangler d1 migrations apply uptime_worker_d1 --local'
    )
    expect(packageJson.scripts['d1:migrate:remote']).toBe(
      'wrangler d1 migrations apply uptime_worker_d1 --remote'
    )
    expect(packageJson.scripts['d1:init']).toBeUndefined()
    expect(packageJson.scripts['d1:migrate']).toBeUndefined()
    expect(readme).toMatch(/new install/i)
    expect(readme).toMatch(/compatibility install/i)
    expect(readme).toContain('deploy/init.sql')
    expect(readme).toContain('wrangler d1 migrations apply uptime_worker_d1 --remote')
  })
})
