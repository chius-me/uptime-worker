import { DurableObject } from 'cloudflare:workers'
import type {
  MonitorStateCompactedV2,
  NotificationEvent,
  PublicMessage,
  WorkerConfig,
} from '../types/config'
import { workerConfig } from '../uptime.config'
import { validateAndResolveConfig } from './config'
import type { Env } from './index'
import { logEvent } from './log'
import { fetchAndConsumeWithTimeout } from './probe'
import {
  persistRun as persistMonitoringRun,
  runMonitoring as executeMonitoringRun,
  type CallbackAction,
  type RunOutput,
} from './run-monitoring'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import {
  formatStatusChangeNotification,
  webhookNotify as deliverWebhook,
} from './util'

export type DispatchSummary = {
  attempted: number
  delivered: number
  failed: number
}

export type RunSummary = {
  status: 'completed' | 'skipped-overlap'
  scheduledAt: number
  runId?: string
  total?: number
  succeeded?: number
  failed?: number
  durationMs?: number
  notifications?: DispatchSummary
}

export type SchedulerDependencies = {
  resolveConfig: (env: Env) => WorkerConfig
  runMonitoring: typeof executeMonitoringRun
  persistRun: typeof persistMonitoringRun
  invokeCallbacks: typeof invokeCallbackActions
  sendHeartbeat: typeof sendHeartbeat
  dispatchPendingNotifications: typeof dispatchPendingNotifications
  randomUUID: () => string
}

export type DispatchDependencies = {
  now?: () => number
  resolveConfig?: (env: Env) => WorkerConfig
  webhookNotify?: typeof deliverWebhook
}

type StoredOutboxRow = {
  event_key: string
  payload: string
  status: 'pending'
  attempts: number
  next_attempt_at: number
}

type StoredPayload = {
  eventKey: string
  incidentId: string
  monitorId: string
  kind: NotificationEvent['kind']
  startedAt: number
  checkedAt: number
  publicMessage: PublicMessage
}

const PUBLIC_MESSAGES = new Set<PublicMessage>([
  'Not checked yet',
  'OK',
  'Timeout',
  'Unexpected status code',
  'TLS validation failed',
  'Content check failed',
  'Content check inconclusive',
  'Connection failed',
])

function runtimeConfig(env: Env): WorkerConfig {
  return validateAndResolveConfig(workerConfig, {
    ...env,
    VPS1_PORT: env.VPS1_PORT || '22',
  } as Record<string, unknown>)
}

const defaultDependencies: SchedulerDependencies = {
  resolveConfig: runtimeConfig,
  runMonitoring: executeMonitoringRun,
  persistRun: persistMonitoringRun,
  invokeCallbacks: invokeCallbackActions,
  sendHeartbeat,
  dispatchPendingNotifications,
  randomUUID: () => crypto.randomUUID(),
}

function parseStoredPayload(row: StoredOutboxRow): StoredPayload {
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    throw new Error('invalid_payload')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_payload')
  }
  const record = value as Record<string, unknown>
  const keys = [
    'eventKey',
    'incidentId',
    'monitorId',
    'kind',
    'startedAt',
    'checkedAt',
    'publicMessage',
  ]
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    record.eventKey !== row.event_key ||
    typeof record.incidentId !== 'string' ||
    typeof record.monitorId !== 'string' ||
    (record.kind !== 'down' && record.kind !== 'recovery') ||
    !Number.isSafeInteger(record.startedAt) ||
    (record.startedAt as number) < 0 ||
    !Number.isSafeInteger(record.checkedAt) ||
    (record.checkedAt as number) < (record.startedAt as number) ||
    typeof record.publicMessage !== 'string' ||
    !PUBLIC_MESSAGES.has(record.publicMessage as PublicMessage) ||
    record.eventKey !== `${record.incidentId}:${record.kind}`
  ) {
    throw new Error('invalid_payload')
  }
  return record as StoredPayload
}

function markDelivered(
  state: MonitorStateCompactedV2,
  payload: StoredPayload,
  deliveredAt: number
): void {
  const columns = state.incident[payload.monitorId]
  const index = columns?.id.indexOf(payload.incidentId) ?? -1
  if (!columns || index < 0) throw new Error('incident_not_found')
  if (payload.kind === 'down') {
    if (columns.downEventKey[index] !== payload.eventKey) throw new Error('event_mismatch')
    columns.downNotifiedAt[index] = deliveredAt
  } else {
    if (columns.recoveryEventKey[index] !== payload.eventKey) throw new Error('event_mismatch')
    columns.recoveryNotifiedAt[index] = deliveredAt
  }
}

async function recordDeliveryFailure(
  env: Env,
  row: StoredOutboxRow,
  now: number,
  code: string
): Promise<void> {
  const delay = Math.min(3600, 30 * (2 ** Math.min(row.attempts, 20)))
  await env.UPTIME_WORKER_D1.prepare(
    `UPDATE notification_outbox
     SET attempts = attempts + 1, next_attempt_at = ?, last_error_code = ?
     WHERE event_key = ? AND status = 'pending'`
  ).bind(now + delay, code, row.event_key).run()
}

export async function dispatchPendingNotifications(
  env: Env,
  limit: number,
  dependencies: DispatchDependencies = {}
): Promise<DispatchSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer from 1 through 100')
  }
  const now = (dependencies.now ?? (() => Math.floor(Date.now() / 1000)))()
  const config = (dependencies.resolveConfig ?? runtimeConfig)(env)
  const webhookNotify = dependencies.webhookNotify ?? deliverWebhook
  const due = await env.UPTIME_WORKER_D1.prepare(
    `SELECT candidate.event_key, candidate.payload, candidate.status,
            candidate.attempts, candidate.next_attempt_at
     FROM notification_outbox AS candidate
     WHERE candidate.status = 'pending'
       AND candidate.next_attempt_at <= ?
       AND (
         json_extract(candidate.payload, '$.kind') = 'down'
         OR EXISTS (
           SELECT 1
           FROM notification_outbox AS down
           WHERE down.event_key = json_extract(candidate.payload, '$.incidentId') || ':down'
             AND down.status = 'delivered'
         )
       )
     ORDER BY candidate.next_attempt_at ASC,
              CAST(json_extract(candidate.payload, '$.checkedAt') AS INTEGER) ASC,
              CASE json_extract(candidate.payload, '$.kind') WHEN 'down' THEN 0 ELSE 1 END ASC,
              candidate.event_key ASC
     LIMIT ?`
  ).bind(now, limit).all<StoredOutboxRow>()
  const rows = due.results ?? []
  const summary: DispatchSummary = { attempted: 0, delivered: 0, failed: 0 }

  for (const row of rows) {
    summary.attempted += 1
    let payload: StoredPayload
    try {
      payload = parseStoredPayload(row)
      const monitor = config.monitors.find(({ id }) => id === payload.monitorId)
      if (!monitor || !config.notification?.webhook) throw new Error('delivery_unavailable')
      const message = formatStatusChangeNotification(
        monitor,
        payload.kind === 'recovery',
        payload.startedAt,
        payload.checkedAt,
        payload.publicMessage,
        config.notification.timeZone ?? 'Etc/GMT'
      )
      await webhookNotify(env, config.notification.webhook, message, payload.eventKey)
    } catch {
      await recordDeliveryFailure(env, row, now, 'delivery_failed')
      summary.failed += 1
      logEvent('notification_delivery_failed', { eventKey: row.event_key })
      continue
    }

    try {
      const wrapper = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
      markDelivered(wrapper.data, payload, now)
      await env.UPTIME_WORKER_D1.batch([
        env.UPTIME_WORKER_D1.prepare(
          `UPDATE notification_outbox
           SET status = 'delivered', delivered_at = ?, last_error_code = NULL
           WHERE event_key = ? AND status = 'pending'`
        ).bind(now, row.event_key),
        env.UPTIME_WORKER_D1.prepare(
          'INSERT INTO uptimeflare (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).bind('state', wrapper.getCompactedStateStr()),
      ])
      summary.delivered += 1
    } catch {
      summary.failed += 1
      logEvent('notification_confirmation_failed', { eventKey: row.event_key })
    }
  }
  return summary
}

export async function invokeCallbackActions(
  env: Env,
  config: WorkerConfig,
  actions: readonly CallbackAction[]
): Promise<void> {
  for (const action of actions) {
    const monitor = config.monitors.find(({ id }) => id === action.monitorId)
    if (!monitor) continue
    try {
      if (action.type === 'status-change') {
        await config.callbacks?.onStatusChange?.(
          env,
          monitor,
          action.isUp === true,
          action.startedAt,
          action.checkedAt,
          action.publicMessage
        )
      } else {
        await config.callbacks?.onIncident?.(
          env,
          monitor,
          action.startedAt,
          action.checkedAt,
          action.publicMessage
        )
      }
    } catch {
      logEvent('callback_failed', {
        type: action.type === 'status-change' ? 'on_status_change' : 'on_incident',
      })
    }
  }
}

export async function sendHeartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return
  try {
    const url = new URL(env.HEARTBEAT_URL)
    if (url.protocol !== 'https:') throw new Error('invalid_heartbeat_url')
    await fetchAndConsumeWithTimeout(
      url.toString(),
      5_000,
      async (response) => {
        if (!response.ok) throw new Error('heartbeat_failed')
      },
      { method: 'GET' }
    )
  } catch {
    logEvent('heartbeat_failed', {})
  }
}

export class Scheduler extends DurableObject<Env> {
  private activeRun: Promise<RunSummary> | null = null
  private readonly schedulerEnv: Env
  private readonly dependencies: SchedulerDependencies

  constructor(
    ctx: DurableObjectState,
    env: Env,
    dependencies: SchedulerDependencies = defaultDependencies
  ) {
    super(ctx, env)
    this.schedulerEnv = env
    this.dependencies = dependencies
  }

  async run(scheduledAt: number): Promise<RunSummary> {
    if (this.activeRun) return { status: 'skipped-overlap', scheduledAt }
    this.activeRun = this.execute(scheduledAt)
    try {
      return await this.activeRun
    } finally {
      this.activeRun = null
    }
  }

  private async execute(scheduledAt: number): Promise<RunSummary> {
    const config = this.dependencies.resolveConfig(this.schedulerEnv)
    const now = Math.floor(scheduledAt / 1000)
    const runId = `${scheduledAt}:${this.dependencies.randomUUID()}`
    const output = await this.dependencies.runMonitoring(
      this.schedulerEnv,
      config,
      now,
      runId
    )
    await this.dependencies.persistRun(this.schedulerEnv, output)
    await this.dependencies.invokeCallbacks(this.schedulerEnv, config, output.callbacks)
    try {
      await this.dependencies.sendHeartbeat(this.schedulerEnv)
    } catch {
      logEvent('heartbeat_failed', {})
    }
    const notifications = await this.dependencies.dispatchPendingNotifications(
      this.schedulerEnv,
      20
    )
    logEvent('monitor_run_completed', {
      runId: output.summary.runId,
      total: output.summary.total,
      succeeded: output.summary.succeeded,
      failed: output.summary.failed,
      durationMs: output.summary.durationMs,
    })
    return {
      status: 'completed',
      scheduledAt,
      runId: output.summary.runId,
      total: output.summary.total,
      succeeded: output.summary.succeeded,
      failed: output.summary.failed,
      durationMs: output.summary.durationMs,
      notifications,
    }
  }
}
