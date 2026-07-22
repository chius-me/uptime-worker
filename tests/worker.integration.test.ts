import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyD1Migrations, env, reset, SELF, type D1Migration } from 'cloudflare:test'
import worker, { type Env } from '../src/index'
import { persistRun, runMonitoring } from '../src/run-monitoring'
import { dispatchPendingNotifications } from '../src/scheduler'
import { CompactedMonitorStateWrapper } from '../src/store'
import { workerConfig } from '../uptime.config'

type IntegrationEnv = Env & {
  TEST_MIGRATIONS: D1Migration[]
  TEST_PASSWORD_PROTECTION: string
}

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

function removedMonitorState(options: { recovered?: boolean } = {}) {
  const recovered = options.recovered ?? true
  return new CompactedMonitorStateWrapper(JSON.stringify({
    schemaVersion: 2,
    lastUpdate: 1_000,
    lastRun: 1_000,
    overallUp: recovered ? 1 : 0,
    overallDown: recovered ? 0 : 1,
    monitoringStartedAt: { removed: 100 },
    incident: {
      removed: {
        id: ['removed:100'],
        startedAt: [100],
        resolvedAt: [recovered ? 130 : null],
        changes: [[{
          at: 100,
          internalError: 'Connection: refused',
          publicMessage: 'Connection failed',
        }]],
        downEventKey: ['removed:100:down'],
        recoveryEventKey: [recovered ? 'removed:100:recovery' : null],
        downNotifiedAt: [null],
        recoveryNotifiedAt: [null],
      },
    },
    latency: {},
  })).data
}

function removedPayload(kind: 'down' | 'recovery'): string {
  return JSON.stringify({
    eventKey: `removed:100:${kind}`,
    incidentId: 'removed:100',
    monitorId: 'removed',
    kind,
    startedAt: 100,
    checkedAt: kind === 'down' ? 100 : 130,
    publicMessage: kind === 'down' ? 'Connection failed' : 'OK',
  })
}

async function seedRemovedMonitor(recovered = true): Promise<void> {
  const state = new CompactedMonitorStateWrapper(
    JSON.stringify(removedMonitorState({ recovered }))
  ).getCompactedStateStr()
  const statements = [
    testEnv.UPTIME_WORKER_D1.prepare(
      'INSERT INTO uptimeflare (key, value) VALUES (?, ?)'
    ).bind('state', state),
    testEnv.UPTIME_WORKER_D1.prepare(
      `INSERT INTO notification_outbox
        (event_key, payload, status, attempts, next_attempt_at)
       VALUES (?, ?, 'pending', 0, ?)`
    ).bind('removed:100:down', removedPayload('down'), 100),
  ]
  if (recovered) {
    statements.push(testEnv.UPTIME_WORKER_D1.prepare(
      `INSERT INTO notification_outbox
        (event_key, payload, status, attempts, next_attempt_at)
       VALUES (?, ?, 'pending', 0, ?)`
    ).bind('removed:100:recovery', removedPayload('recovery'), 130))
  }
  await testEnv.UPTIME_WORKER_D1.batch(statements)
}

async function runScheduled(scheduledTime: number): Promise<void> {
  await worker.scheduled(
    { scheduledTime } as ScheduledEvent,
    testEnv,
    {} as ExecutionContext
  )
}

async function seedFreshState(sampledMonitorIds: string[]): Promise<number> {
  const now = Math.round(Date.now() / 1_000)
  const state = new CompactedMonitorStateWrapper(null)
  state.data.lastUpdate = now
  state.data.lastRun = now
  state.data.overallUp = sampledMonitorIds.length
  for (const monitorId of sampledMonitorIds) {
    state.data.monitoringStartedAt[monitorId] = now - 60
    state.appendLatency(monitorId, { time: now, ping: 42, loc: 'SFO' })
  }
  await testEnv.UPTIME_WORKER_D1.prepare(
    'INSERT INTO uptimeflare (key, value) VALUES (?, ?)'
  ).bind('state', state.getCompactedStateStr()).run()
  return now
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

  it('resolves only password protection from an environment-backed secret on page requests', async () => {
    workerConfig.passwordProtection = 'member:<TEST_PASSWORD_PROTECTION>'
    workerConfig.monitors = [{
      id: 'unresolved-monitor-secret',
      name: 'Unresolved monitor secret',
      method: 'GET',
      target: 'https://<MONITOR_HOST_THAT_MUST_NOT_RESOLVE_ON_FETCH>',
    }]

    const literalPlaceholder = await SELF.fetch('https://example.test/index.html', {
      headers: { Authorization: `Basic ${btoa('member:<TEST_PASSWORD_PROTECTION>')}` },
    })
    expect(literalPlaceholder.status).toBe(401)

    const authenticated = await SELF.fetch('https://example.test/index.html', {
      headers: { Authorization: `Basic ${btoa(`member:${testEnv.TEST_PASSWORD_PROTECTION}`)}` },
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

  it('keeps fresh zero-monitor data and health initializing', async () => {
    workerConfig.monitors = []
    await seedFreshState([])

    const data = await SELF.fetch('https://example.test/api/data')
    const health = await SELF.fetch('https://example.test/api/health')

    expect(data.status).toBe(200)
    await expect(data.json()).resolves.toMatchObject({
      up: 0,
      down: 0,
      stale: false,
      monitoringStatus: 'initializing',
    })
    expect(health.status).toBe(503)
    await expect(health.json()).resolves.toMatchObject({
      stale: false,
      monitoringStatus: 'initializing',
    })
  })

  it('reports fresh sampled state as healthy through data and health routes', async () => {
    workerConfig.monitors = [{
      id: 'api',
      name: 'API',
      method: 'GET',
      target: 'https://api.example',
    }]
    await seedFreshState(['api'])

    const data = await SELF.fetch('https://example.test/api/data')
    const health = await SELF.fetch('https://example.test/api/health')

    expect(data.status).toBe(200)
    await expect(data.json()).resolves.toMatchObject({
      up: 1,
      down: 0,
      stale: false,
      monitoringStatus: 'healthy',
    })
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      stale: false,
      monitoringStatus: 'healthy',
    })
  })

  it('keeps data and health initializing after adding an unsampled monitor', async () => {
    workerConfig.monitors = [
      { id: 'api', name: 'API', method: 'GET', target: 'https://api.example' },
    ]
    await seedFreshState(['api'])

    const beforeConfigChange = await SELF.fetch('https://example.test/api/data')
    await expect(beforeConfigChange.json()).resolves.toMatchObject({ monitoringStatus: 'healthy' })

    workerConfig.monitors.push(
      { id: 'new', name: 'New', method: 'GET', target: 'https://new.example' }
    )
    const data = await SELF.fetch('https://example.test/api/data')
    const health = await SELF.fetch('https://example.test/api/health')

    await expect(data.json()).resolves.toMatchObject({
      stale: false,
      monitoringStatus: 'initializing',
      monitors: { api: { up: true }, new: { up: null } },
    })
    expect(health.status).toBe(503)
    await expect(health.json()).resolves.toMatchObject({
      stale: false,
      monitoringStatus: 'initializing',
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

  it('retries removed-monitor recovery/down reconciliation atomically before terminalizing both', async () => {
    await seedRemovedMonitor()
    const notify = vi.fn(async () => undefined)
    const dependencies = {
      now: () => 1_000,
      resolveConfig: () => ({ monitors: [], notification: { webhook: {
        url: 'https://hooks.example/token',
        payloadType: 'json' as const,
        payload: { text: '$MSG' },
      } } }),
      webhookNotify: notify,
    }
    await testEnv.UPTIME_WORKER_D1.exec(
      "CREATE TRIGGER reject_removed_state_update BEFORE UPDATE OF value ON uptimeflare WHEN OLD.key = 'state' BEGIN SELECT RAISE(ABORT, 'state update rejected'); END"
    )

    await dispatchPendingNotifications(testEnv, 20, dependencies)

    const pendingAfterFailure = await testEnv.UPTIME_WORKER_D1.prepare(
      `SELECT event_key, attempts FROM notification_outbox
       WHERE status = 'pending' ORDER BY event_key`
    ).all<{ event_key: string; attempts: number }>()
    expect(pendingAfterFailure.results).toEqual([
      { event_key: 'removed:100:down', attempts: 0 },
      { event_key: 'removed:100:recovery', attempts: 0 },
    ])
    const stateAfterFailure = new CompactedMonitorStateWrapper(
      (await testEnv.UPTIME_WORKER_D1.prepare(
        'SELECT value FROM uptimeflare WHERE key = ?'
      ).bind('state').first<{ value: string }>())!.value
    ).data
    expect(stateAfterFailure.incident.removed.downEventKey).toEqual(['removed:100:down'])
    expect(stateAfterFailure.incident.removed.recoveryEventKey).toEqual(['removed:100:recovery'])

    await testEnv.UPTIME_WORKER_D1.exec('DROP TRIGGER reject_removed_state_update')
    await dispatchPendingNotifications(testEnv, 20, dependencies)

    const terminal = await testEnv.UPTIME_WORKER_D1.prepare(
      `SELECT event_key, status, last_error_code FROM notification_outbox
       WHERE event_key LIKE 'removed:%' ORDER BY event_key`
    ).all<{ event_key: string; status: string; last_error_code: string | null }>()
    expect(terminal.results).toEqual([
      { event_key: 'removed:100:down', status: 'delivered', last_error_code: 'removed_monitor' },
      { event_key: 'removed:100:recovery', status: 'delivered', last_error_code: 'removed_monitor' },
    ])
    const stateAfterRetry = new CompactedMonitorStateWrapper(
      (await testEnv.UPTIME_WORKER_D1.prepare(
        'SELECT value FROM uptimeflare WHERE key = ?'
      ).bind('state').first<{ value: string }>())!.value
    ).data
    expect(stateAfterRetry.incident.removed.downEventKey).toEqual([null])
    expect(stateAfterRetry.incident.removed.recoveryEventKey).toEqual([null])
    expect(notify).not.toHaveBeenCalled()
  })

  it('targets removed state despite a large unrelated pending backlog and prunes only after retirement', async () => {
    await seedRemovedMonitor(false)
    await testEnv.UPTIME_WORKER_D1.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000
       )
       INSERT INTO notification_outbox
         (event_key, payload, status, attempts, next_attempt_at)
       SELECT
         'zzother:' || value || ':down',
         json_object(
           'eventKey', 'zzother:' || value || ':down',
           'incidentId', 'zzother:' || value,
           'monitorId', 'zzother',
           'kind', 'down',
           'startedAt', value,
           'checkedAt', value,
           'publicMessage', 'Connection failed'
         ),
         'pending', 0, 999999999
       FROM sequence`
    ).run()

    const beforeRetirement = await runMonitoring(
      testEnv,
      { monitors: [] },
      1_000,
      'removed-before-retirement',
      { getWorkerLocation: async () => 'SFO' }
    )
    expect(beforeRetirement.state.monitoringStartedAt.removed).toBe(100)
    expect(beforeRetirement.state.incident.removed).toBeDefined()
    await persistRun(testEnv, beforeRetirement)

    await dispatchPendingNotifications(testEnv, 20, {
      now: () => 1_000,
      resolveConfig: () => ({ monitors: [] }),
      webhookNotify: vi.fn(async () => undefined),
    })
    const afterRetirement = await runMonitoring(
      testEnv,
      { monitors: [] },
      1_001,
      'removed-after-retirement',
      { getWorkerLocation: async () => 'SFO' }
    )

    expect(afterRetirement.state.monitoringStartedAt.removed).toBeUndefined()
    expect(afterRetirement.state.incident.removed).toBeUndefined()
    expect(afterRetirement.state.latency.removed).toBeUndefined()
    const unrelated = await testEnv.UPTIME_WORKER_D1.prepare(
      `SELECT COUNT(*) AS count FROM notification_outbox
       WHERE status = 'pending'
         AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.monitorId') ELSE NULL END = 'zzother'`
    ).first<{ count: number }>()
    expect(unrelated?.count).toBe(2_000)
  })

  it('preserves removed state for a marker-matching row whose JSON payload is malformed', async () => {
    await seedRemovedMonitor(false)
    await testEnv.UPTIME_WORKER_D1.prepare(
      'UPDATE notification_outbox SET payload = ? WHERE event_key = ?'
    ).bind('{not-json', 'removed:100:down').run()

    const beforeRetirement = await runMonitoring(
      testEnv,
      { monitors: [] },
      1_000,
      'removed-malformed-before',
      { getWorkerLocation: async () => 'SFO' }
    )

    expect(beforeRetirement.state.incident.removed.downEventKey).toEqual(['removed:100:down'])
    await persistRun(testEnv, beforeRetirement)
    await dispatchPendingNotifications(testEnv, 20, {
      now: () => 1_000,
      resolveConfig: () => ({ monitors: [] }),
      webhookNotify: vi.fn(async () => undefined),
    })
    const row = await testEnv.UPTIME_WORKER_D1.prepare(
      'SELECT status, last_error_code FROM notification_outbox WHERE event_key = ?'
    ).bind('removed:100:down').first<{ status: string; last_error_code: string | null }>()
    expect(row).toEqual({ status: 'delivered', last_error_code: 'invalid_payload' })

    const afterRetirement = await runMonitoring(
      testEnv,
      { monitors: [] },
      1_001,
      'removed-malformed-after',
      { getWorkerLocation: async () => 'SFO' }
    )
    expect(afterRetirement.state.incident.removed).toBeUndefined()
  })

  it('uses the pending-monitor event-key index for bounded removed-state lookups', async () => {
    const plan = await testEnv.UPTIME_WORKER_D1.prepare(
      `EXPLAIN QUERY PLAN
       WITH monitor_ranges(monitor_id, lower_bound, upper_bound) AS (
         VALUES (?, ?, ?)
       )
       SELECT monitor_id FROM monitor_ranges
       WHERE EXISTS (
         SELECT 1 FROM notification_outbox
         WHERE status = 'pending'
           AND event_key >= lower_bound
           AND event_key < upper_bound
         LIMIT 1
       )
       ORDER BY monitor_id ASC
       LIMIT ?`
    ).bind('removed', 'removed:', 'removed;', 20).all<{ detail: string }>()

    expect(plan.results?.map(({ detail }) => detail).join(' '))
      .toContain('notification_outbox_pending_monitor')
  })

  it('uses event-key range seeks for the actual removed-event retirement query shape', async () => {
    const plan = await testEnv.UPTIME_WORKER_D1.prepare(
      `EXPLAIN QUERY PLAN
       WITH monitor_ranges(monitor_id, lower_bound, upper_bound) AS (
         VALUES (?, ?, ?)
       )
       SELECT outbox.event_key, outbox.payload, outbox.status,
              outbox.attempts, outbox.next_attempt_at
       FROM monitor_ranges
       JOIN notification_outbox AS outbox
         ON outbox.status = 'pending'
        AND outbox.event_key >= monitor_ranges.lower_bound
        AND outbox.event_key < monitor_ranges.upper_bound
       ORDER BY monitor_ranges.monitor_id ASC, outbox.event_key DESC
       LIMIT ?`
    ).bind('removed', 'removed:', 'removed;', 10).all<{ detail: string }>()
    const detail = plan.results?.map((row) => row.detail).join(' ') ?? ''

    expect(detail).toContain('notification_outbox_pending_monitor')
    expect(detail).toMatch(/event_key[>]?\? AND event_key[<]?\?/i)
  })

  it('uses indexed range seeks for the reserved configured-monitor delivery query', async () => {
    const plan = await testEnv.UPTIME_WORKER_D1.prepare(
      `EXPLAIN QUERY PLAN
       WITH configured_monitors(monitor_id) AS (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       )
       SELECT outbox.event_key, outbox.payload, outbox.status,
              outbox.attempts, outbox.next_attempt_at
       FROM configured_monitors
       CROSS JOIN notification_outbox AS outbox INDEXED BY notification_outbox_pending_monitor
       WHERE outbox.status = 'pending'
         AND outbox.event_key >= configured_monitors.monitor_id || ':'
         AND outbox.event_key < configured_monitors.monitor_id || ';'
         AND outbox.next_attempt_at <= ?
       ORDER BY outbox.next_attempt_at ASC, outbox.event_key ASC
       LIMIT ?`
    ).bind(JSON.stringify(['web']), 1_000, 20).all<{ detail: string }>()
    const detail = plan.results?.map((row) => row.detail).join(' ') ?? ''

    expect(detail).toContain('notification_outbox_pending_monitor')
    expect(detail).toMatch(/event_key[>]?\? AND event_key[<]?\?/i)
  })
})
