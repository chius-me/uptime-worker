import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyD1Migrations, env, reset, SELF, type D1Migration } from 'cloudflare:test'
import worker, { type Env } from '../src/index'
import { persistRun } from '../src/run-monitoring'
import { dispatchPendingNotifications } from '../src/scheduler'
import { CompactedMonitorStateWrapper } from '../src/store'
import { workerConfig } from '../uptime.config'

type IntegrationEnv = Env & { TEST_MIGRATIONS: D1Migration[] }

const testEnv = env as unknown as IntegrationEnv
const configuredWorker = structuredClone(workerConfig)

function restoreWorkerConfig(): void {
  for (const key of Object.keys(workerConfig)) {
    delete (workerConfig as Record<string, unknown>)[key]
  }
  Object.assign(workerConfig, structuredClone(configuredWorker))
}

function configureEmptyScheduledRun(): void {
  workerConfig.monitors = []
  delete workerConfig.notification
  delete workerConfig.callbacks
}

async function runScheduled(scheduledTime: number): Promise<void> {
  await worker.scheduled(
    { scheduledTime } as ScheduledEvent,
    testEnv,
    {} as ExecutionContext
  )
}

beforeEach(async () => {
  restoreWorkerConfig()
  await reset()
  await applyD1Migrations(testEnv.UPTIME_WORKER_D1, testEnv.TEST_MIGRATIONS)
})

afterEach(() => {
  restoreWorkerConfig()
})

describe('Worker runtime integration', () => {
  it('serves initializing data without a D1 state row', async () => {
    const response = await SELF.fetch('https://example.test/api/data')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ monitoringStatus: 'initializing' })
  })

  it('protects static assets before passing them to the ASSETS binding', async () => {
    workerConfig.passwordProtection = 'member:secret'

    const unauthenticated = await SELF.fetch('https://example.test/index.html')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('WWW-Authenticate')).toBe('Basic')

    const authenticated = await SELF.fetch('https://example.test/index.html', {
      headers: { Authorization: `Basic ${btoa('member:secret')}` },
    })
    expect(authenticated.status).toBe(200)
    expect(authenticated.headers.get('content-type')).toContain('text/html')
  })

  it('returns an error badge for an unknown monitor through the fetch binding', async () => {
    const response = await SELF.fetch('https://example.test/api/badge?id=does-not-exist')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      message: 'unknown-monitor',
      isError: true,
    })
  })

  it('returns 503 for stale health data stored in D1', async () => {
    const state = new CompactedMonitorStateWrapper(null).getCompactedStateStr()
    await testEnv.UPTIME_WORKER_D1.prepare(
      'INSERT INTO uptimeflare (key, value) VALUES (?, ?)'
    ).bind('state', state).run()

    const response = await SELF.fetch('https://example.test/api/health')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      monitoringStatus: 'initializing',
      stale: true,
    })
  })

  it('serializes duplicate scheduled events through the Scheduler Durable Object', async () => {
    configureEmptyScheduledRun()

    await Promise.all([runScheduled(1_000), runScheduled(1_001)])

    const runs = await testEnv.UPTIME_WORKER_D1.prepare(
      'SELECT COUNT(*) AS count FROM monitor_runs'
    ).first<{ count: number }>()
    expect(runs?.count).toBe(1)
  })

  it('keeps a monitoring run atomic when the D1 state write fails', async () => {
    await testEnv.UPTIME_WORKER_D1.exec(
      "CREATE TRIGGER reject_state_write BEFORE INSERT ON uptimeflare BEGIN SELECT RAISE(ABORT, 'state write rejected'); END"
    )

    await expect(persistRun(testEnv, {
      state: new CompactedMonitorStateWrapper(null).data,
      events: [],
      callbacks: [],
      summary: {
        runId: 'state-write-failure',
        scheduledAt: 1_000,
        completedAt: 1_000,
        total: 0,
        succeeded: 0,
        failed: 0,
        durationMs: 0,
      },
    })).rejects.toThrow()

    const runs = await testEnv.UPTIME_WORKER_D1.prepare(
      'SELECT COUNT(*) AS count FROM monitor_runs'
    ).first<{ count: number }>()
    expect(runs?.count).toBe(0)
  })

  it('records a retryable outbox failure in D1 when delivery has no usable webhook', async () => {
    workerConfig.monitors = workerConfig.monitors.filter(({ id }) => id === 'blog')
    delete workerConfig.notification
    const state = new CompactedMonitorStateWrapper(JSON.stringify({
      schemaVersion: 2,
      lastUpdate: 1_000,
      lastRun: 1_000,
      overallUp: 0,
      overallDown: 1,
      monitoringStartedAt: { blog: 1_000 },
      incident: {
        blog: {
          id: ['blog:1000'],
          startedAt: [1_000],
          resolvedAt: [null],
          changes: [[{
            at: 1_000,
            internalError: 'Connection: refused',
            publicMessage: 'Connection failed',
          }]],
          downEventKey: ['blog:1000:down'],
          recoveryEventKey: [null],
          downNotifiedAt: [null],
          recoveryNotifiedAt: [null],
        },
      },
      latency: {},
    })).getCompactedStateStr()
    const payload = JSON.stringify({
      eventKey: 'blog:1000:down',
      incidentId: 'blog:1000',
      monitorId: 'blog',
      kind: 'down',
      startedAt: 1_000,
      checkedAt: 1_000,
      publicMessage: 'Connection failed',
    })
    await testEnv.UPTIME_WORKER_D1.batch([
      testEnv.UPTIME_WORKER_D1.prepare(
        'INSERT INTO uptimeflare (key, value) VALUES (?, ?)'
      ).bind('state', state),
      testEnv.UPTIME_WORKER_D1.prepare(
        `INSERT INTO notification_outbox
          (event_key, payload, status, attempts, next_attempt_at)
         VALUES (?, ?, 'pending', 0, ?)`
      ).bind('blog:1000:down', payload, 1_000),
    ])

    await expect(dispatchPendingNotifications(testEnv, 20, { now: () => 1_000 }))
      .resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 })

    const row = await testEnv.UPTIME_WORKER_D1.prepare(
      'SELECT attempts, next_attempt_at, last_error_code FROM notification_outbox WHERE event_key = ?'
    ).bind('blog:1000:down').first<{
      attempts: number
      next_attempt_at: number
      last_error_code: string | null
    }>()
    expect(row).toEqual({
      attempts: 1,
      next_attempt_at: 1_030,
      last_error_code: 'delivery_failed',
    })
  })
})
