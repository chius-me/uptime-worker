import pLimit from 'p-limit'
import type {
  IncidentRecordV2,
  MaintenanceConfig,
  MonitorStateCompactedV2,
  MonitorTarget,
  NotificationEvent,
  PublicMessage,
  WorkerConfig,
} from '../types/config'
import type { Env } from './index'
import { doMonitor as checkMonitor } from './monitor'
import { failedProbe, type ProbeStatus } from './probe'
import {
  applyNotificationSuppression,
  transitionMonitor,
} from './state-machine'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import { getWorkerLocation as resolveWorkerLocation } from './util'
import { maintenances as configuredMaintenances } from '../uptime.config'
import { hasUsableWebhook } from './config'

type CheckResult = { id: string; location: string; status: ProbeStatus }

const INCIDENT_RETENTION_SECONDS = 90 * 24 * 60 * 60
// Two event-key binds per incident plus one LIMIT bind must stay below D1's 100-parameter ceiling.
const MAX_RETENTION_INCIDENTS_PER_RUN = 49
const MAX_REMOVED_MONITORS_PER_RUN = 20

export type CallbackAction = {
  type: 'status-change' | 'incident'
  monitorId: string
  isUp?: boolean
  startedAt: number
  checkedAt: number
  publicMessage: PublicMessage
}

export type RunSummaryRecord = {
  runId: string
  scheduledAt: number
  completedAt: number
  total: number
  succeeded: number
  failed: number
  durationMs: number
}

export type RunOutput = {
  state: MonitorStateCompactedV2
  events: NotificationEvent[]
  callbacks: CallbackAction[]
  summary: RunSummaryRecord
}

export type RunDependencies = {
  doMonitor?: (
    monitor: MonitorTarget,
    defaultLocation: string,
    env: Env
  ) => Promise<CheckResult>
  getWorkerLocation?: () => Promise<string>
  maintenances?: readonly MaintenanceConfig[]
  nowMs?: () => number
  scheduledAt?: number
}

function incidentAt(
  state: MonitorStateCompactedV2,
  monitorId: string,
  index: number
): IncidentRecordV2 {
  const columns = state.incident[monitorId]
  return {
    id: columns.id[index],
    startedAt: columns.startedAt[index],
    resolvedAt: columns.resolvedAt[index],
    changes: columns.changes[index].map((change) => ({ ...change })),
    downEventKey: columns.downEventKey[index],
    recoveryEventKey: columns.recoveryEventKey[index],
    downNotifiedAt: columns.downNotifiedAt[index],
    recoveryNotifiedAt: columns.recoveryNotifiedAt[index],
  }
}

function latestIncident(state: MonitorStateCompactedV2, monitorId: string): IncidentRecordV2 | null {
  const columns = state.incident[monitorId]
  return columns && columns.id.length > 0 ? incidentAt(state, monitorId, columns.id.length - 1) : null
}

function storeIncident(
  state: MonitorStateCompactedV2,
  monitorId: string,
  previous: IncidentRecordV2 | null,
  incident: IncidentRecordV2 | null
): void {
  if (incident === null) return
  const columns = state.incident[monitorId] ??= {
    id: [],
    startedAt: [],
    resolvedAt: [],
    changes: [],
    downEventKey: [],
    recoveryEventKey: [],
    downNotifiedAt: [],
    recoveryNotifiedAt: [],
  }
  const index = previous?.id === incident.id ? columns.id.length - 1 : columns.id.length
  columns.id[index] = incident.id
  columns.startedAt[index] = incident.startedAt
  columns.resolvedAt[index] = incident.resolvedAt
  columns.changes[index] = incident.changes.map((change) => ({ ...change }))
  columns.downEventKey[index] = incident.downEventKey
  columns.recoveryEventKey[index] = incident.recoveryEventKey
  columns.downNotifiedAt[index] = incident.downNotifiedAt
  columns.recoveryNotifiedAt[index] = incident.recoveryNotifiedAt
}

function timestampSeconds(value: number | string): number {
  if (typeof value === 'number') return value > 100_000_000_000 ? Math.floor(value / 1000) : value
  return Math.floor(new Date(value).getTime() / 1000)
}

function maintenanceMonitorIds(maintenances: readonly MaintenanceConfig[], now: number): string[] {
  const ids = new Set<string>()
  for (const maintenance of maintenances) {
    const start = timestampSeconds(maintenance.start)
    const end = maintenance.end === undefined ? null : timestampSeconds(maintenance.end)
    if (Number.isFinite(start) && start <= now && (end === null || end >= now)) {
      for (const monitorId of maintenance.monitors ?? []) ids.add(monitorId)
    }
  }
  return [...ids]
}

function statusChanged(
  previous: IncidentRecordV2 | null,
  incident: IncidentRecordV2 | null,
  status: ProbeStatus
): boolean {
  if (status.up) return previous?.resolvedAt === null && incident?.resolvedAt !== null
  if (incident === null) return false
  if (previous === null || previous.id !== incident.id) return true
  return previous.changes.length !== incident.changes.length
}

type RetentionCandidates = {
  incidentIds: ReadonlySet<string>
  eventKeys: readonly string[]
}

function collectRetentionCandidates(
  state: MonitorStateCompactedV2,
  monitorIds: readonly string[],
  now: number
): RetentionCandidates {
  const incidentIds = new Set<string>()
  const eventKeys = new Set<string>()
  let selectedIncidentCount = 0
  for (const monitorId of [...monitorIds].sort()) {
    const columns = state.incident[monitorId]
    if (!columns) continue
    for (let index = 0; index < columns.id.length; index += 1) {
      const resolvedAt = columns.resolvedAt[index]
      if (resolvedAt === null || resolvedAt >= now - INCIDENT_RETENTION_SECONDS) break
      if (selectedIncidentCount >= MAX_RETENTION_INCIDENTS_PER_RUN) {
        return { incidentIds, eventKeys: [...eventKeys] }
      }
      selectedIncidentCount += 1
      incidentIds.add(columns.id[index])
      const downEventKey = columns.downEventKey[index]
      const recoveryEventKey = columns.recoveryEventKey[index]
      if (downEventKey !== null) eventKeys.add(downEventKey)
      if (recoveryEventKey !== null) eventKeys.add(recoveryEventKey)
    }
  }
  return { incidentIds, eventKeys: [...eventKeys] }
}

function removedMonitorCandidates(
  state: MonitorStateCompactedV2,
  configuredMonitorIds: ReadonlySet<string>
): string[] {
  return [...new Set([
    ...Object.keys(state.monitoringStartedAt),
    ...Object.keys(state.incident),
    ...Object.keys(state.latency),
  ])]
    .filter((monitorId) => !configuredMonitorIds.has(monitorId))
    .sort()
    .slice(0, MAX_REMOVED_MONITORS_PER_RUN)
}

async function pendingEventKeysForCandidates(
  env: Env,
  eventKeys: readonly string[]
): Promise<Set<string>> {
  if (eventKeys.length === 0) return new Set()
  const placeholders = eventKeys.map(() => '?').join(', ')
  const result = await env.UPTIME_WORKER_D1.prepare(
    `SELECT event_key FROM notification_outbox
     WHERE status = 'pending'
       AND event_key IN (${placeholders})
     ORDER BY event_key ASC
     LIMIT ?`
  ).bind(...eventKeys, eventKeys.length).all<{ event_key: string }>()
  return new Set(
    (result.results ?? [])
      .map(({ event_key }) => event_key)
      .filter((eventKey) => typeof eventKey === 'string')
  )
}

async function pendingRemovedMonitorIds(
  env: Env,
  monitorIds: readonly string[]
): Promise<Set<string>> {
  if (monitorIds.length === 0) return new Set()
  const rangeRows = monitorIds.map(() => '(?, ?, ?)').join(', ')
  const ranges = monitorIds.flatMap((monitorId) => [
    monitorId,
    `${monitorId}:`,
    `${monitorId};`,
  ])
  const result = await env.UPTIME_WORKER_D1.prepare(
    `WITH monitor_ranges(monitor_id, lower_bound, upper_bound) AS (
       VALUES ${rangeRows}
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
  ).bind(...ranges, monitorIds.length).all<{ monitor_id: string }>()
  return new Set(
    (result.results ?? [])
      .map(({ monitor_id }) => monitor_id)
      .filter((monitorId) => typeof monitorId === 'string')
  )
}

function pruneRemovedMonitorState(
  state: MonitorStateCompactedV2,
  monitorId: string
): void {
  delete state.monitoringStartedAt[monitorId]
  delete state.incident[monitorId]
  delete state.latency[monitorId]
}

function retainRecentData(
  wrapper: CompactedMonitorStateWrapper,
  monitorId: string,
  now: number,
  pendingEventKeys: ReadonlySet<string>,
  retentionIncidentIds: ReadonlySet<string>
): void {
  while (
    wrapper.latencyLen(monitorId) > 0 &&
    wrapper.getFirstLatency(monitorId).time < now - 12 * 60 * 60
  ) {
    wrapper.unshiftLatency(monitorId)
  }

  const columns = wrapper.data.incident[monitorId]
  if (!columns) return
  while (
    columns.id.length > 0 &&
    columns.resolvedAt[0] !== null &&
    columns.resolvedAt[0]! < now - INCIDENT_RETENTION_SECONDS &&
    retentionIncidentIds.has(columns.id[0]) &&
    (columns.downEventKey[0] === null || !pendingEventKeys.has(columns.downEventKey[0]!)) &&
    (columns.recoveryEventKey[0] === null || !pendingEventKeys.has(columns.recoveryEventKey[0]!))
  ) {
    for (const values of Object.values(columns)) values.shift()
  }
  if (columns.id.length === 0) delete wrapper.data.incident[monitorId]
}

export async function runMonitoring(
  env: Env,
  config: WorkerConfig,
  now: number,
  runId: string,
  dependencies: RunDependencies = {}
): Promise<RunOutput> {
  const startedAtMs = (dependencies.nowMs ?? Date.now)()
  const wrapper = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
  const configuredMonitorIds = new Set(config.monitors.map(({ id }) => id))
  const removedCandidates = removedMonitorCandidates(wrapper.data, configuredMonitorIds)
  const removedWithPendingRows = await pendingRemovedMonitorIds(env, removedCandidates)
  for (const monitorId of removedCandidates) {
    if (!removedWithPendingRows.has(monitorId)) pruneRemovedMonitorState(wrapper.data, monitorId)
  }
  const retentionCandidates = collectRetentionCandidates(
    wrapper.data,
    config.monitors.map(({ id }) => id),
    now
  )
  const pendingEventKeys = await pendingEventKeysForCandidates(
    env,
    retentionCandidates.eventKeys
  )
  const getWorkerLocation = dependencies.getWorkerLocation ?? resolveWorkerLocation
  const doMonitor = dependencies.doMonitor ?? checkMonitor
  let workerLocation = 'unknown'
  try {
    workerLocation = (await getWorkerLocation()) || 'unknown'
  } catch {
    workerLocation = 'unknown'
  }

  const limit = pLimit(5)
  const settled = await Promise.allSettled(config.monitors.map((monitor) => (
    limit(() => doMonitor(monitor, workerLocation, env))
  )))
  const events: NotificationEvent[] = []
  const callbacks: CallbackAction[] = []
  const maintenanceIds = maintenanceMonitorIds(
    dependencies.maintenances ?? configuredMaintenances,
    now
  )
  let succeeded = 0
  let failed = 0
  let overallUp = 0
  let overallDown = 0

  config.monitors.forEach((monitor, index) => {
    const result = settled[index]
    let check: CheckResult
    if (result.status === 'fulfilled') {
      succeeded += 1
      check = result.value
    } else {
      failed += 1
      check = {
        id: monitor.id,
        location: 'unknown',
        status: failedProbe('Connection: probe execution failed'),
      }
    }

    const previous = latestIncident(wrapper.data, monitor.id)
    const transitioned = transitionMonitor(
      { monitorId: monitor.id, incident: previous },
      check.status,
      now,
      (config.notification?.gracePeriod ?? 0) * 60
    )
    const notification = applyNotificationSuppression(transitioned, {
      maintenanceMonitorIds: maintenanceIds,
      skipNotificationIds: config.notification?.skipNotificationIds,
      notificationsEnabled: hasUsableWebhook(config.notification?.webhook),
    })
    storeIncident(wrapper.data, monitor.id, previous, notification.incident)
    events.push(...notification.events)

    const incident = notification.incident
    if (statusChanged(previous, incident, check.status) && incident) {
      callbacks.push({
        type: 'status-change',
        monitorId: monitor.id,
        isUp: check.status.up,
        startedAt: incident.startedAt,
        checkedAt: now,
        publicMessage: check.status.up ? 'OK' : check.status.publicMessage,
      })
    }
    if (!check.status.up && incident) {
      callbacks.push({
        type: 'incident',
        monitorId: monitor.id,
        startedAt: incident.startedAt,
        checkedAt: now,
        publicMessage: check.status.publicMessage,
      })
    }

    check.status.up ? overallUp += 1 : overallDown += 1
    wrapper.data.monitoringStartedAt[monitor.id] ??= now
    wrapper.appendLatency(monitor.id, {
      loc: check.location || 'unknown',
      ping: check.status.ping,
      time: now,
    })
    retainRecentData(
      wrapper,
      monitor.id,
      now,
      pendingEventKeys,
      retentionCandidates.incidentIds
    )
  })

  wrapper.data.overallUp = overallUp
  wrapper.data.overallDown = overallDown
  wrapper.data.lastRun = now
  wrapper.data.lastUpdate = now
  const completedAtMs = (dependencies.nowMs ?? Date.now)()

  return {
    state: wrapper.data,
    events,
    callbacks,
    summary: {
      runId,
      scheduledAt: dependencies.scheduledAt ?? now,
      completedAt: Math.floor(completedAtMs / 1000),
      total: config.monitors.length,
      succeeded,
      failed,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
    },
  }
}

export async function persistRun(env: Env, output: RunOutput): Promise<void> {
  const state = new CompactedMonitorStateWrapper(JSON.stringify(output.state)).getCompactedStateStr()
  const statements: D1PreparedStatement[] = [
    env.UPTIME_WORKER_D1.prepare(
      'INSERT INTO uptimeflare (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind('state', state),
    env.UPTIME_WORKER_D1.prepare(
      `INSERT INTO monitor_runs
        (run_id, scheduled_at, completed_at, total, succeeded, failed, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`
    ).bind(
      output.summary.runId,
      output.summary.scheduledAt,
      output.summary.completedAt,
      output.summary.total,
      output.summary.succeeded,
      output.summary.failed,
      output.summary.durationMs
    ),
  ]

  for (const event of output.events) {
    const payload = JSON.stringify({
      eventKey: event.eventKey,
      incidentId: event.incidentId,
      monitorId: event.monitorId,
      kind: event.kind,
      startedAt: event.payload.startedAt,
      checkedAt: event.payload.checkedAt,
      publicMessage: event.payload.publicMessage,
    })
    statements.push(env.UPTIME_WORKER_D1.prepare(
      `INSERT INTO notification_outbox
        (event_key, payload, status, attempts, next_attempt_at)
       VALUES (?, ?, 'pending', 0, ?)
       ON CONFLICT(event_key) DO NOTHING`
    ).bind(event.eventKey, payload, event.payload.checkedAt))
  }

  await env.UPTIME_WORKER_D1.batch(statements)
}
