import type { Env } from '../src'

export type PageConfig = {
  title?: string
  links?: PageConfigLink[]
  group?: PageConfigGroup
  favicon?: string
  logo?: string
  maintenances?: {
    upcomingColor?: string
  }
  customFooter?: string
}

export type MaintenanceConfig = {
  monitors?: string[]
  title?: string
  body: string
  start: number | string
  end?: number | string
  color?: string
}

export type PageConfigGroup = { [key: string]: string[] }

export type PageConfigLink = {
  link: string
  label: string
  highlight?: boolean
}

export type MonitorTarget = {
  id: string
  name: string
  method: string
  target: string
  tooltip?: string
  statusPageLink?: string
  hideLatencyChart?: boolean
  expectedCodes?: number[]
  timeout?: number
  headers?: { [key: string]: string | number }
  body?: string
  responseKeyword?: string
  responseForbiddenKeyword?: string
  checkProxy?: string
  checkProxyFallback?: boolean
  checkProxyAllowedHosts?: string[]
  forwardHeaders?: string[]
}

export type WorkerConfig<TEnv = Env> = {
  kvWriteCooldownMinutes?: number
  passwordProtection?: string
  monitors: MonitorTarget[]
  notification?: Notification
  callbacks?: Callbacks<TEnv>
}

export type Notification = {
  webhook?: WebhookConfig
  timeZone?: string
  gracePeriod?: number
  skipNotificationIds?: string[]
  skipErrorChangeNotification?: boolean
}

type SingleWebhook = {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers?: { [key: string]: string | number }
  payloadType: 'param' | 'json' | 'x-www-form-urlencoded'
  payload: Record<string, unknown>
  timeout?: number
}

export type WebhookConfig = SingleWebhook | SingleWebhook[]

export type Callbacks<TEnv = Env> = {
  onStatusChange?: (
    env: TEnv,
    monitor: MonitorTarget,
    isUp: boolean,
    timeIncidentStart: number,
    timeNow: number,
    reason: string
  ) => Promise<any> | any
  onIncident?: (
    env: TEnv,
    monitor: MonitorTarget,
    timeIncidentStart: number,
    timeNow: number,
    reason: string
  ) => Promise<any> | any
}

export type IncidentRecord = {
  start: number[]
  end: number | null // null if it's still open
  error: string[]
}

export type PublicMessage =
  | 'Not checked yet'
  | 'OK'
  | 'Timeout'
  | 'Unexpected status code'
  | 'TLS validation failed'
  | 'Content check failed'
  | 'Content check inconclusive'
  | 'Connection failed'

export type PublicIncidentChange = {
  at: number
  publicMessage: PublicMessage
}

export type ErrorChange = {
  at: number
  internalError: string
  publicMessage: PublicMessage
}

export type IncidentRecordV2 = {
  id: string
  startedAt: number
  resolvedAt: number | null
  changes: ErrorChange[]
  downEventKey: string | null
  recoveryEventKey: string | null
  downNotifiedAt: number | null
  recoveryNotifiedAt: number | null
}

export type NotificationPayload = {
  startedAt: number
  checkedAt: number
  publicMessage: PublicMessage
}

export type NotificationEvent = {
  eventKey: string
  incidentId: string
  monitorId: string
  kind: 'down' | 'recovery'
  payload: NotificationPayload
}

// v1 chart fields are retained until the frontend consumes the v2 fields.
export type PublicIncident = {
  id: string
  startedAt: number
  resolvedAt: number | null
  changes: PublicIncidentChange[]
  start: number[]
  end: number | null
  error: PublicMessage[]
}

export type MonitorSummary = {
  up: boolean | null
  latency: number | null
  location: string | null
  message: PublicMessage
}

export type MonitoringStatus = 'initializing' | 'delayed' | 'healthy'

export type DataPayload = {
  schemaVersion: 2
  up: number
  down: number
  updatedAt: number
  stale: boolean
  monitoringStatus: MonitoringStatus
  monitors: Record<string, MonitorSummary>
  config: PageConfig
  monitorsConfig: Pick<MonitorTarget, 'id' | 'name' | 'tooltip' | 'statusPageLink' | 'hideLatencyChart'>[]
  state: {
    incident: Record<string, PublicIncident[]>
    latency: Record<string, PublicLatencyRecord[]>
  }
}

export type LatencyRecord = {
  loc: string
  ping: number
  time: number
}

export type PublicLatencyRecord = Omit<LatencyRecord, 'loc'> & {
  loc: string | null
}

export type MonitorState = {
  lastUpdate: number
  overallUp: number
  overallDown: number
  incident: Record<string, IncidentRecord[]>
  latency: Record<string, LatencyRecord[]> // recent 12 hour data, N min interval
}

// This is now the actual stored format (after 2026/01/01 D1 migration) to improve (de)serialization performance
// This gives a ~3.5x speedup in computing and a 40-60% reduction in size
// The CPULimitExceeded issue with 10+ monitors on free tier should be mitigated by this change
// local profiling result (1 op = parse + stringify):
// MonitorState (original): 277 ops/s, ±0.51%   | slowest, 71.09% slower
// MonitorStateCompacted:   958 ops/s, ±1.17%   | fastest
// Real world test with 8 monitors and a few hundred incidents and full latency data (status.lyc8503.net):
// original: 433KB size, 11.24ms P50 cpu time, 18.11ms P99 cpu time
// compacted: 181KB size (59% smaller), 6.36ms P50 cpu time (43% faster), 8.86ms P99 cpu time (51% faster)
export type MonitorStateCompactedV1 = {
  lastUpdate: number
  overallUp: number
  overallDown: number

  // incident in stored in columnar format
  incident: Record<
    string, // monitor id
    {
      start: number[][]
      end: (number | null)[]
      error: string[][]
    }
  >

  // latency in stored in columnar format
  // also uses Run-length encoding for loc & Base64 encoding for number arrays
  latency: Record<
    string, // monitor id
    {
      loc: {
        v: string[] // RLE values
        c: number[] // RLE counts
      }
      // Hex results in a larger size and slower encoding/decoding than base64,
      // but we can pop/append arbitrary number of bytes without decoding then re-encoding the whole string
      // This is useful in Workers and shows a ~2% speedup comapred to base64, and it also simplifies the code
      ping: string // Hex encoded Uint16Array
      time: string // Hex encoded Uint32Array
    }
  >
}

type CompactedIncidentV2 = {
  id: string[]
  startedAt: number[]
  resolvedAt: (number | null)[]
  changes: ErrorChange[][]
  downEventKey: (string | null)[]
  recoveryEventKey: (string | null)[]
  downNotifiedAt: (number | null)[]
  recoveryNotifiedAt: (number | null)[]
}

export type MonitorStateCompactedV2 = {
  schemaVersion: 2
  lastUpdate: number
  lastRun: number
  overallUp: number
  overallDown: number
  monitoringStartedAt: Record<string, number>
  incident: Record<string, CompactedIncidentV2>
  latency: MonitorStateCompactedV1['latency']
}

export type MonitorStateCompacted = MonitorStateCompactedV2
