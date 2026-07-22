import { DurableObject } from 'cloudflare:workers'
import type {
  MonitorStateCompactedV2,
  NotificationEvent,
  PublicMessage,
  WorkerConfig,
} from '../types/config'
import { workerConfig } from '../uptime.config'
import { hasUsableWebhook, validateAndResolveConfig } from './config'
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
  withTimeout,
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
  cleanupRetention: typeof cleanupD1Retention
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

type StoredEventIdentity = Pick<
  StoredPayload,
  'eventKey' | 'incidentId' | 'monitorId' | 'kind'
>

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
const SAFE_MONITOR_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_STORED_PAYLOAD_LENGTH = 2_048

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
  cleanupRetention: cleanupD1Retention,
  randomUUID: () => crypto.randomUUID(),
}

function parseStoredPayload(row: StoredOutboxRow): StoredPayload {
  if (
    typeof row.event_key !== 'string' ||
    row.event_key.length < 1 ||
    row.event_key.length > 128 ||
    typeof row.payload !== 'string' ||
    row.payload.length < 1 ||
    row.payload.length > MAX_STORED_PAYLOAD_LENGTH
  ) {
    throw new Error('invalid_payload')
  }
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
    !SAFE_MONITOR_ID.test(record.monitorId) ||
    (record.kind !== 'down' && record.kind !== 'recovery') ||
    !Number.isSafeInteger(record.startedAt) ||
    (record.startedAt as number) < 0 ||
    !Number.isSafeInteger(record.checkedAt) ||
    (record.checkedAt as number) < (record.startedAt as number) ||
    typeof record.publicMessage !== 'string' ||
    !PUBLIC_MESSAGES.has(record.publicMessage as PublicMessage) ||
    record.incidentId !== `${record.monitorId}:${record.startedAt}` ||
    record.eventKey !== `${record.incidentId}:${record.kind}` ||
    (record.kind === 'recovery' && record.publicMessage !== 'OK') ||
    (record.kind === 'down' && (
      record.publicMessage === 'OK' || record.publicMessage === 'Not checked yet'
    ))
  ) {
    throw new Error('invalid_payload')
  }
  return record as StoredPayload
}

function parseStoredIdentity(row: StoredOutboxRow): StoredEventIdentity | null {
  if (typeof row.payload !== 'string' || row.payload.length > MAX_STORED_PAYLOAD_LENGTH) return null
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.monitorId !== 'string' ||
    !SAFE_MONITOR_ID.test(record.monitorId) ||
    !Number.isSafeInteger(record.startedAt) ||
    (record.startedAt as number) < 0 ||
    typeof record.incidentId !== 'string' ||
    record.incidentId !== `${record.monitorId}:${record.startedAt}` ||
    (record.kind !== 'down' && record.kind !== 'recovery') ||
    typeof record.eventKey !== 'string' ||
    record.eventKey !== row.event_key ||
    record.eventKey !== `${record.incidentId}:${record.kind}`
  ) return null
  return {
    eventKey: record.eventKey,
    incidentId: record.incidentId,
    monitorId: record.monitorId,
    kind: record.kind,
  }
}

function hasMatchingEvent(state: MonitorStateCompactedV2, payload: StoredPayload): boolean {
  const columns = state.incident[payload.monitorId]
  const index = columns?.id.indexOf(payload.incidentId) ?? -1
  if (!columns || index < 0) return false
  return payload.kind === 'down'
    ? columns.downEventKey[index] === payload.eventKey
    : columns.recoveryEventKey[index] === payload.eventKey
}

function reconcileTerminalEvent(
  state: MonitorStateCompactedV2,
  identity: StoredEventIdentity
): boolean {
  const columns = state.incident[identity.monitorId]
  const index = columns?.id.indexOf(identity.incidentId) ?? -1
  if (!columns || index < 0) return false
  if (identity.kind === 'recovery') {
    if (columns.recoveryEventKey[index] !== identity.eventKey) return false
    columns.recoveryEventKey[index] = null
    columns.recoveryNotifiedAt[index] = null
    return true
  }
  if (
    columns.downEventKey[index] !== identity.eventKey ||
    columns.recoveryEventKey[index] !== null
  ) return false
  columns.downEventKey[index] = null
  columns.downNotifiedAt[index] = null
  return true
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

async function terminalizeOutboxRow(
  env: Env,
  row: StoredOutboxRow,
  now: number,
  code: 'invalid_payload' | 'orphaned_event' | 'blocked_dependency',
  identity: StoredEventIdentity | null = null
): Promise<void> {
  const terminalStatement = () => env.UPTIME_WORKER_D1.prepare(
    `UPDATE notification_outbox
     SET status = 'delivered', delivered_at = ?, last_error_code = ?
     WHERE event_key = ? AND status = 'pending'`
  ).bind(now, code, row.event_key)
  if (identity) {
    let wrapper: CompactedMonitorStateWrapper
    try {
      wrapper = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    } catch {
      return
    }
    if (reconcileTerminalEvent(wrapper.data, identity)) {
      try {
        await env.UPTIME_WORKER_D1.batch([
          terminalStatement(),
          env.UPTIME_WORKER_D1.prepare(
            'INSERT INTO uptimeflare (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
          ).bind('state', wrapper.getCompactedStateStr()),
        ])
      } catch {
        // Keep both the state key and Outbox row pending for an atomic retry.
      }
      return
    }
  }
  await terminalStatement().run()
}

async function deferRecovery(
  env: Env,
  row: StoredOutboxRow,
  nextAttemptAt: number
): Promise<void> {
  await env.UPTIME_WORKER_D1.prepare(
    `UPDATE notification_outbox
     SET next_attempt_at = ?
     WHERE event_key = ? AND status = 'pending'`
  ).bind(nextAttemptAt, row.event_key).run()
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
  const summary: DispatchSummary = { attempted: 0, delivered: 0, failed: 0 }
  const scanBatchSize = Math.max(20, Math.min(100, limit))
  const maxScannedRows = Math.min(2_000, Math.max(100, limit * 20))
  let scannedRows = 0
  let scanBatches = 0
  let deliveryAttempts = 0
  const seenEventKeys = new Set<string>()

  while (deliveryAttempts < limit && scannedRows < maxScannedRows && scanBatches < 25) {
    const due = await env.UPTIME_WORKER_D1.prepare(
      `SELECT candidate.event_key, candidate.payload, candidate.status,
              candidate.attempts, candidate.next_attempt_at
       FROM notification_outbox AS candidate
       WHERE candidate.status = 'pending'
         AND candidate.next_attempt_at <= ?
       ORDER BY candidate.next_attempt_at ASC,
                candidate.event_key ASC
       LIMIT ?`
    ).bind(
      now,
      Math.min(2_500, scanBatchSize + seenEventKeys.size)
    ).all<StoredOutboxRow>()
    const rows = (due.results ?? []).filter(({ event_key }) => !seenEventKeys.has(event_key))
    scanBatches += 1
    if (rows.length === 0) break

    for (const row of rows) {
      if (deliveryAttempts >= limit || scannedRows >= maxScannedRows) break
      seenEventKeys.add(row.event_key)
      scannedRows += 1
      summary.attempted += 1

      let payload: StoredPayload
      try {
        payload = parseStoredPayload(row)
      } catch {
        await terminalizeOutboxRow(
          env,
          row,
          now,
          'invalid_payload',
          parseStoredIdentity(row)
        )
        summary.failed += 1
        logEvent('notification_invalid_payload', {})
        continue
      }

      if (payload.kind === 'recovery') {
        const down = await env.UPTIME_WORKER_D1.prepare(
          `SELECT status, last_error_code, next_attempt_at
           FROM notification_outbox WHERE event_key = ?`
        ).bind(`${payload.incidentId}:down`).first<{
          status: 'pending' | 'delivered'
          last_error_code: string | null
          next_attempt_at: number
        }>()
        if (!down || (down.status === 'delivered' && down.last_error_code !== null)) {
          await terminalizeOutboxRow(env, row, now, 'blocked_dependency', payload)
          summary.failed += 1
          logEvent('notification_blocked_dependency', {
            monitorId: payload.monitorId,
            kind: payload.kind,
          })
          continue
        }
        if (down.status === 'pending') {
          await deferRecovery(env, row, Math.max(now + 30, down.next_attempt_at))
          continue
        }
      }

      let wrapper: CompactedMonitorStateWrapper
      try {
        wrapper = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
      } catch {
        await recordDeliveryFailure(env, row, now, 'delivery_failed')
        summary.failed += 1
        logEvent('notification_delivery_failed', { monitorId: payload.monitorId, kind: payload.kind })
        continue
      }
      if (!hasMatchingEvent(wrapper.data, payload)) {
        await terminalizeOutboxRow(env, row, now, 'orphaned_event', payload)
        summary.failed += 1
        logEvent('notification_orphaned', { monitorId: payload.monitorId, kind: payload.kind })
        continue
      }

      const monitor = config.monitors.find(({ id }) => id === payload.monitorId)
      const webhook = config.notification?.webhook
      if (!monitor || !hasUsableWebhook(webhook)) {
        await recordDeliveryFailure(env, row, now, 'delivery_failed')
        summary.failed += 1
        logEvent('notification_delivery_failed', { monitorId: payload.monitorId, kind: payload.kind })
        continue
      }

      deliveryAttempts += 1
      try {
        const message = formatStatusChangeNotification(
          monitor,
          payload.kind === 'recovery',
          payload.startedAt,
          payload.checkedAt,
          payload.publicMessage,
          config.notification?.timeZone ?? 'Etc/GMT'
        )
        await webhookNotify(env, webhook, message, payload.eventKey)
      } catch {
        await recordDeliveryFailure(env, row, now, 'delivery_failed')
        summary.failed += 1
        logEvent('notification_delivery_failed', { monitorId: payload.monitorId, kind: payload.kind })
        continue
      }

      try {
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
        logEvent('notification_confirmation_failed', { monitorId: payload.monitorId, kind: payload.kind })
      }
    }
  }
  return summary
}

export async function invokeCallbackActions(
  env: Env,
  config: WorkerConfig,
  actions: readonly CallbackAction[]
): Promise<void> {
  await Promise.allSettled(actions.map(async (action) => {
    const monitor = config.monitors.find(({ id }) => id === action.monitorId)
    if (!monitor) return
    try {
      if (action.type === 'status-change') {
        const callback = config.callbacks?.onStatusChange
        if (!callback) return
        await withTimeout(5_000, Promise.resolve(callback(
          env,
          monitor,
          action.isUp === true,
          action.startedAt,
          action.checkedAt,
          action.publicMessage
        )))
      } else {
        const callback = config.callbacks?.onIncident
        if (!callback) return
        await withTimeout(5_000, Promise.resolve(callback(
          env,
          monitor,
          action.startedAt,
          action.checkedAt,
          action.publicMessage
        )))
      }
    } catch {
      logEvent('callback_failed', {
        type: action.type === 'status-change' ? 'on_status_change' : 'on_incident',
      })
    }
  }))
}

export async function cleanupD1Retention(
  env: Env,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  const cutoff = now - 90 * 24 * 60 * 60
  try {
    await env.UPTIME_WORKER_D1.batch([
      env.UPTIME_WORKER_D1.prepare(
        `DELETE FROM monitor_runs
         WHERE run_id IN (
           SELECT run_id FROM monitor_runs
           WHERE completed_at < ?
           ORDER BY completed_at ASC
           LIMIT 1000
         )`
      ).bind(cutoff),
      env.UPTIME_WORKER_D1.prepare(
        `DELETE FROM notification_outbox
         WHERE event_key IN (
           SELECT candidate.event_key FROM notification_outbox AS candidate
           WHERE candidate.status = 'delivered'
             AND candidate.delivered_at IS NOT NULL
             AND candidate.delivered_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM notification_outbox AS dependent
               WHERE dependent.status = 'pending'
                 AND candidate.event_key GLOB '*:down'
                 AND dependent.event_key =
                   substr(candidate.event_key, 1, length(candidate.event_key) - 4) || 'recovery'
             )
           ORDER BY candidate.delivered_at ASC
           LIMIT 1000
         )`
      ).bind(cutoff),
    ])
  } catch {
    logEvent('retention_cleanup_failed', {})
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
    const notifications = await this.dependencies.dispatchPendingNotifications(
      this.schedulerEnv,
      20
    )
    try {
      await this.dependencies.cleanupRetention(this.schedulerEnv, now)
    } catch {
      logEvent('retention_cleanup_failed', {})
    }
    try {
      await this.dependencies.sendHeartbeat(this.schedulerEnv)
    } catch {
      logEvent('heartbeat_failed', {})
    }
    await this.dependencies.invokeCallbacks(this.schedulerEnv, config, output.callbacks)
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
