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
  notificationsEnabled?: boolean
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
  return events.filter(({ monitorId }) => (
    policy.notificationsEnabled !== false &&
    !maintenance.has(monitorId) &&
    !skipped.has(monitorId)
  ))
}

export function applyNotificationSuppression(
  transition: TransitionResult,
  policy: NotificationSuppressionPolicy
): TransitionResult {
  const events = filterNotificationEvents(transition.events, policy)
  if (events.length === transition.events.length || transition.incident === null) {
    return {
      state: {
        monitorId: transition.state.monitorId,
        incident: transition.state.incident ? copyIncident(transition.state.incident) : null,
      },
      incident: transition.incident ? copyIncident(transition.incident) : null,
      events: [...events],
    }
  }

  const retainedKeys = new Set(events.map(({ eventKey }) => eventKey))
  const incident = copyIncident(transition.incident)
  for (const event of transition.events) {
    if (retainedKeys.has(event.eventKey)) continue
    if (event.kind === 'down' && incident.downEventKey === event.eventKey) {
      incident.downEventKey = null
    }
    if (event.kind === 'recovery' && incident.recoveryEventKey === event.eventKey) {
      incident.recoveryEventKey = null
    }
  }

  return {
    state: { monitorId: transition.state.monitorId, incident },
    incident,
    events,
  }
}
