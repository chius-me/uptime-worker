import type {
  IncidentRecordV2,
  NotificationEvent,
  NotificationPayload,
} from '../types/config'
import { publicMessageForInternalError, type ProbeStatus } from './probe'

export type MonitorTransitionState = {
  monitorId: string
  incident: IncidentRecordV2 | null
}

export type TransitionResult = {
  state: MonitorTransitionState
  incident: IncidentRecordV2 | null
  events: NotificationEvent[]
}

export type NotificationSuppressionPolicy = {
  maintenanceMonitorIds?: readonly string[]
  skipNotificationIds?: readonly string[]
}

function copyIncident(incident: IncidentRecordV2): IncidentRecordV2 {
  return {
    ...incident,
    changes: incident.changes.map((change) => ({ ...change })),
  }
}

function notificationEvent(
  monitorId: string,
  incident: IncidentRecordV2,
  kind: NotificationEvent['kind'],
  checkedAt: number,
  publicMessage: NotificationPayload['publicMessage']
): NotificationEvent {
  return {
    eventKey: `${incident.id}:${kind}`,
    incidentId: incident.id,
    monitorId,
    kind,
    payload: {
      startedAt: incident.startedAt,
      checkedAt,
      publicMessage,
    },
  }
}

export function transitionMonitor(
  state: MonitorTransitionState,
  result: ProbeStatus,
  checkedAt: number,
  graceSeconds: number
): TransitionResult {
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw new TypeError('checkedAt must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) {
    throw new TypeError('graceSeconds must be a non-negative safe integer')
  }

  let incident = state.incident ? copyIncident(state.incident) : null
  const events: NotificationEvent[] = []

  if (!result.up && (!incident || incident.resolvedAt !== null)) {
    incident = {
      id: `${state.monitorId}:${checkedAt}`,
      startedAt: checkedAt,
      resolvedAt: null,
      changes: [{
        at: checkedAt,
        internalError: result.internalError,
        publicMessage: publicMessageForInternalError(result.internalError),
      }],
      downEventKey: null,
      recoveryEventKey: null,
      downNotifiedAt: null,
      recoveryNotifiedAt: null,
    }
  } else if (!result.up && incident) {
    const previousError = incident.changes[incident.changes.length - 1]?.internalError
    if (previousError !== result.internalError) {
      incident.changes.push({
        at: checkedAt,
        internalError: result.internalError,
        publicMessage: publicMessageForInternalError(result.internalError),
      })
    }
  }

  if (
    !result.up &&
    incident &&
    checkedAt - incident.startedAt >= graceSeconds &&
    incident.downEventKey === null
  ) {
    const event = notificationEvent(
      state.monitorId,
      incident,
      'down',
      checkedAt,
      incident.changes[incident.changes.length - 1].publicMessage
    )
    incident.downEventKey = event.eventKey
    events.push(event)
  } else if (result.up && incident?.resolvedAt === null) {
    incident.resolvedAt = checkedAt
    if (incident.downEventKey !== null && incident.recoveryEventKey === null) {
      const event = notificationEvent(state.monitorId, incident, 'recovery', checkedAt, 'OK')
      incident.recoveryEventKey = event.eventKey
      events.push(event)
    }
  }

  const nextState = { monitorId: state.monitorId, incident }
  return { state: nextState, incident, events }
}

export function filterNotificationEvents(
  events: readonly NotificationEvent[],
  policy: NotificationSuppressionPolicy
): NotificationEvent[] {
  const maintenance = new Set(policy.maintenanceMonitorIds ?? [])
  const skipped = new Set(policy.skipNotificationIds ?? [])
  return events.filter(({ monitorId }) => !maintenance.has(monitorId) && !skipped.has(monitorId))
}
