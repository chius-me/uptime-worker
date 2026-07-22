import { workerConfig } from '../uptime.config'
import type {
  DataPayload,
  IncidentRecord,
  MonitorState,
  MonitorTarget,
  MonitoringStatus,
  PageConfig,
  PublicIncident,
  PublicMessage,
} from '../types/config'
import type { Env } from './index'
import { publicMessageForInternalError } from './probe'
import {
  CompactedMonitorStateWrapper,
  CorruptStateError,
  getFromStore,
  isLegacyDummyIncident,
} from './store'

const STALE_AFTER_SECONDS = 180
const globalpingLocationPart = /^[\p{L} '-]+$/u

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function stateUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: 'State unavailable' }), {
    status: 503,
    headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
  })
}

async function readMonitorState(env: Env): Promise<CompactedMonitorStateWrapper | Response> {
  try {
    return new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
  } catch (error) {
    if (error instanceof CorruptStateError) return stateUnavailableResponse()
    throw error
  }
}

const publicMessages = new Set<PublicMessage>([
  'Not checked yet',
  'OK',
  'Timeout',
  'Unexpected status code',
  'TLS validation failed',
  'Content check failed',
  'Content check inconclusive',
  'Connection failed',
])

type V2Incident = {
  id: string
  startedAt: number
  resolvedAt: number | null
  changes: Array<{ at: number; publicMessage?: string; internalError?: string; error?: string }>
}

export type BadgePayload = {
  schemaVersion: 1
  label: string
  message: string
  color: string
  isError?: boolean
}

export function publicMessage(error: string): PublicMessage {
  return publicMessageForInternalError(error)
}

function asPublicMessage(value: string | undefined): PublicMessage {
  if (value && publicMessages.has(value as PublicMessage)) return value as PublicMessage
  return publicMessage(value ?? '')
}

function isV2Incident(incident: IncidentRecord | V2Incident): incident is V2Incident {
  return 'startedAt' in incident && 'changes' in incident
}

export function toPublicIncident(monitorId: string, incident: IncidentRecord | V2Incident): PublicIncident {
  if (isV2Incident(incident)) {
    const changes = incident.changes.map(({ at, publicMessage: message, internalError, error }) => ({
      at,
      publicMessage: asPublicMessage(message ?? internalError ?? error),
    }))
    return {
      id: incident.id,
      startedAt: incident.startedAt,
      resolvedAt: incident.resolvedAt,
      changes,
      start: changes.map(({ at }) => at),
      end: incident.resolvedAt,
      error: changes.map(({ publicMessage: message }) => message),
    }
  }

  const startedAt = incident.start[0] ?? 0
  const changes = incident.error.map((error, index) => ({
    at: incident.start[index] ?? startedAt,
    publicMessage: publicMessage(error),
  }))
  return {
    id: `${monitorId}:${startedAt}`,
    startedAt,
    resolvedAt: incident.end,
    changes,
    start: [...incident.start],
    end: incident.end,
    error: changes.map(({ publicMessage: message }) => message),
  }
}

export function getMonitoringStatus(lastUpdate: number, now: number): {
  stale: boolean
  monitoringStatus: MonitoringStatus
} {
  const stale = lastUpdate === 0 || now - lastUpdate > STALE_AFTER_SECONDS
  return {
    stale,
    monitoringStatus: lastUpdate === 0 ? 'initializing' : stale ? 'delayed' : 'healthy',
  }
}

export function deriveMonitoringReadiness(
  lastUpdate: number,
  now: number,
  configuredMonitorIds: string[],
  hasSample: (monitorId: string) => boolean
): { stale: boolean; monitoringStatus: MonitoringStatus } {
  const freshness = getMonitoringStatus(lastUpdate, now)
  if (freshness.monitoringStatus !== 'healthy') return freshness

  const ready = configuredMonitorIds.length > 0 && configuredMonitorIds.every(hasSample)
  return {
    stale: false,
    monitoringStatus: ready ? 'healthy' : 'initializing',
  }
}

export function publicLocation(location: string, monitor: MonitorTarget): string | null {
  const proxy = monitor.checkProxy
  if (!proxy || proxy.startsWith('worker://')) {
    return /^[A-Z]{3}$/.test(location) ? location : null
  }
  if (proxy.startsWith('globalping://')) {
    const parts = location.split('/')
    const validDisplayValue =
      Array.from(location).length <= 64 &&
      parts.length === 2 &&
      parts.every((part) => {
        const length = Array.from(part).length
        return length >= 1 && length <= 30 && globalpingLocationPart.test(part) && /\p{L}/u.test(part)
      })
    return validDisplayValue ? location : null
  }
  return null
}

function publicPageConfig(page: PageConfig): PageConfig {
  return {
    title: page.title || 'UptimeWorker',
    links: page.links || [],
    group: page.group,
    logo: page.logo,
    favicon: page.favicon,
    customFooter: page.customFooter,
    maintenances: page.maintenances,
  }
}

function summaryForMonitor(
  state: MonitorState,
  monitor: MonitorTarget,
  stale: boolean
): DataPayload['monitors'][string] {
  const incidents = (state.incident[monitor.id] || [])
    .filter((incident) => !isLegacyDummyIncident(incident))
  const latencies = state.latency[monitor.id] || []
  const lastIncident = incidents[incidents.length - 1]
  const lastLatency = latencies[latencies.length - 1]

  if (stale || !lastLatency) {
    return { up: null, latency: null, location: null, message: 'Not checked yet' }
  }

  const up = !lastIncident || lastIncident.end !== null
  return {
    up,
    latency: lastLatency.ping,
    location: publicLocation(lastLatency.loc, monitor),
    message: up ? 'OK' : publicMessage(lastIncident!.error[lastIncident!.error.length - 1] ?? ''),
  }
}

export function buildDataPayload(
  state: MonitorState,
  monitorsConfig: MonitorTarget[],
  page: PageConfig,
  now: number
): DataPayload {
  const { stale, monitoringStatus } = deriveMonitoringReadiness(
    state.lastUpdate,
    now,
    monitorsConfig.map(({ id }) => id),
    (monitorId) => (state.latency[monitorId]?.length ?? 0) > 0
  )
  const configuredIds = new Set(monitorsConfig.map(({ id }) => id))
  const monitorById = new Map(monitorsConfig.map((monitor) => [monitor.id, monitor]))
  const legacyMonitoringStartedAt = Object.fromEntries(
    Object.entries(state.incident).flatMap(([id, incidents]) => {
      const dummy = incidents.find(isLegacyDummyIncident)
      return dummy?.start[0] === undefined ? [] : [[id, dummy.start[0]]]
    })
  )
  const monitoringStartedAt = Object.fromEntries(
    Object.entries({ ...legacyMonitoringStartedAt, ...state.monitoringStartedAt })
      .filter(([id]) => configuredIds.has(id))
  )
  const monitors = Object.fromEntries(
    monitorsConfig.map((monitor) => [monitor.id, summaryForMonitor(state, monitor, stale)])
  )
  const monitorSummaries = Object.values(monitors)
  const up = monitorSummaries.filter((summary) => summary.up === true).length
  const down = monitorSummaries.filter((summary) => summary.up === false).length
  const incident = Object.fromEntries(
    Object.entries(state.incident)
      .filter(([id]) => configuredIds.has(id))
      .map(([id, incidents]) => [
        id,
        incidents
          .filter((item) => !isLegacyDummyIncident(item))
          .map((item) => toPublicIncident(id, item)),
      ])
  )
  const latency = Object.fromEntries(
    Object.entries(state.latency)
      .filter(([id]) => configuredIds.has(id))
      .map(([id, samples]) => [
        id,
        samples.map((sample) => ({
          ...sample,
          loc: publicLocation(sample.loc, monitorById.get(id)!),
        })),
      ])
  )

  return {
    schemaVersion: 2,
    up,
    down,
    updatedAt: state.lastUpdate,
    stale,
    monitoringStatus,
    monitors,
    config: publicPageConfig(page),
    monitorsConfig: monitorsConfig.map(({ id, name, tooltip, statusPageLink, hideLatencyChart }) => ({
      id,
      name,
      tooltip,
      statusPageLink,
      hideLatencyChart,
    })),
    state: { monitoringStartedAt, incident, latency },
  }
}

function errorBadge(label: string, message: string): BadgePayload {
  return { schemaVersion: 1, label, message, color: 'lightgrey', isError: true }
}

export async function handleBadgeAPI(request: Request, env: Env, now = Math.round(Date.now() / 1000)): Promise<Response> {
  const url = new URL(request.url)
  const monitorId = url.searchParams.get('id')
  const label = url.searchParams.get('label') ?? monitorId ?? 'UptimeWorker'
  const upMsg = url.searchParams.get('up') ?? 'UP'
  const downMsg = url.searchParams.get('down') ?? 'DOWN'
  const colorUp = url.searchParams.get('colorUp') ?? 'brightgreen'
  const colorDown = url.searchParams.get('colorDown') ?? 'red'

  if (!monitorId) {
    return new Response(JSON.stringify(errorBadge(label, 'no-monitor')), {
      status: 400,
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
    })
  }
  if (!workerConfig.monitors.some((monitor) => monitor.id === monitorId)) {
    return new Response(JSON.stringify(errorBadge(label, 'unknown-monitor')), {
      status: 404,
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
    })
  }

  const stateOrResponse = await readMonitorState(env)
  if (stateOrResponse instanceof Response) return stateOrResponse
  const compactedState = stateOrResponse
  const { stale } = getMonitoringStatus(compactedState.data.lastUpdate, now)
  if (stale) {
    return new Response(JSON.stringify({ schemaVersion: 1, label, message: 'unknown', color: 'lightgrey' }), {
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  const incidentLength = compactedState.incidentLen(monitorId)
  if (incidentLength === 0) {
    return new Response(JSON.stringify({ schemaVersion: 1, label, message: 'unknown', color: 'lightgrey' }), {
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  }

  const lastIncident = compactedState.getIncident(monitorId, incidentLength - 1)
  const up = lastIncident.end !== null
  return new Response(
    JSON.stringify({ schemaVersion: 1, label, message: up ? upMsg : downMsg, color: up ? colorUp : colorDown }),
    { headers: { ...jsonHeaders, 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
  )
}

export async function handleHealthAPI(
  env: Env,
  now = Math.round(Date.now() / 1000),
  monitorsConfig = workerConfig.monitors
): Promise<Response> {
  const stateOrResponse = await readMonitorState(env)
  if (stateOrResponse instanceof Response) return stateOrResponse
  const compactedState = stateOrResponse
  const { stale, monitoringStatus } = deriveMonitoringReadiness(
    compactedState.data.lastUpdate,
    now,
    monitorsConfig.map(({ id }) => id),
    (monitorId) => compactedState.latencyLen(monitorId) > 0
  )
  return new Response(
    JSON.stringify({ monitoringStatus, updatedAt: compactedState.data.lastUpdate, stale }),
    {
      status: monitoringStatus === 'healthy' ? 200 : 503,
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
    }
  )
}
