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

type CheckResult = { id: string; location: string; status: ProbeStatus }

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

function retainRecentData(
  wrapper: CompactedMonitorStateWrapper,
  monitorId: string,
  now: number
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
    columns.resolvedAt[0]! < now - 90 * 24 * 60 * 60
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
      notificationsEnabled: config.notification?.webhook !== undefined,
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
    retainRecentData(wrapper, monitor.id, now)
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
      scheduledAt: now,
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
