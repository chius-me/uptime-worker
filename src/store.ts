import type { Env } from './index'
import type {
  ErrorChange,
  IncidentRecord,
  IncidentRecordV2,
  LatencyRecord,
  MonitorState,
  MonitorStateCompactedV1,
  MonitorStateCompactedV2,
  PublicMessage,
} from '../types/config'
import { publicMessageForInternalError } from './probe'

export async function getFromStore(env: Env, key: string): Promise<string | null> {
  const stmt = env.UPTIME_WORKER_D1.prepare('SELECT value FROM uptimeflare WHERE key = ?')
  const result = await stmt.bind(key).first<{ value: string }>()
  return result?.value ?? null
}

export async function setToStore(env: Env, key: string, value: string): Promise<void> {
  const stmt = env.UPTIME_WORKER_D1.prepare(
    'INSERT INTO uptimeflare (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;'
  )
  await stmt.bind(key, value).run()
}

export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptStateError'
  }
}

type UnknownRecord = Record<string, unknown>

function corrupt(message: string): never {
  throw new CorruptStateError(message)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt(`Invalid ${field}`)
  return value as number
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  return value === null ? null : safeInteger(value, field)
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') corrupt(`Invalid ${field}`)
  return value
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) corrupt(`Invalid ${field}`)
  return value
}

function recordValue(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) corrupt(`Invalid ${field}`)
  return value
}

function bytesToHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

function hexToBytes(hex: string, field: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) corrupt(`Invalid hex in ${field}`)
  const result = new Uint8Array(hex.length / 2)
  for (let index = 0; index < hex.length; index += 2) {
    result[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16)
  }
  return result
}

function encodeUint16(value: number): string {
  return bytesToHex(new Uint8Array(new Uint16Array([value]).buffer))
}

function encodeUint32(value: number): string {
  return bytesToHex(new Uint8Array(new Uint32Array([value]).buffer))
}

function decodeUint16(hex: string): number[] {
  const bytes = hexToBytes(hex, 'latency.ping')
  if (bytes.byteLength % Uint16Array.BYTES_PER_ELEMENT !== 0) {
    corrupt('Misaligned latency.ping hex')
  }
  return Array.from(new Uint16Array(bytes.buffer))
}

function decodeUint32(hex: string): number[] {
  const bytes = hexToBytes(hex, 'latency.time')
  if (bytes.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    corrupt('Misaligned latency.time hex')
  }
  return Array.from(new Uint32Array(bytes.buffer))
}

function emptyIncidentColumns(): MonitorStateCompactedV2['incident'][string] {
  return {
    id: [],
    startedAt: [],
    resolvedAt: [],
    changes: [],
    downEventKey: [],
    recoveryEventKey: [],
    downNotifiedAt: [],
    recoveryNotifiedAt: [],
  }
}

function appendV2Incident(
  columns: MonitorStateCompactedV2['incident'][string],
  incident: IncidentRecordV2,
  atStart = false
): void {
  const method = atStart ? 'unshift' : 'push'
  columns.id[method](incident.id)
  columns.startedAt[method](incident.startedAt)
  columns.resolvedAt[method](incident.resolvedAt)
  columns.changes[method](incident.changes.map((change) => ({ ...change })))
  columns.downEventKey[method](incident.downEventKey)
  columns.recoveryEventKey[method](incident.recoveryEventKey)
  columns.downNotifiedAt[method](incident.downNotifiedAt)
  columns.recoveryNotifiedAt[method](incident.recoveryNotifiedAt)
}

function incidentAt(
  columns: MonitorStateCompactedV2['incident'][string],
  index: number
): IncidentRecordV2 {
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

function legacyIncident(incident: IncidentRecordV2): IncidentRecord {
  return {
    start: incident.changes.map(({ at }) => at),
    end: incident.resolvedAt,
    error: incident.changes.map(({ internalError }) => internalError),
  }
}

function incidentFromLegacy(monitorId: string, incident: IncidentRecord): IncidentRecordV2 {
  if (incident.start.length === 0 || incident.start.length !== incident.error.length) {
    corrupt(`Inconsistent incident changes for ${monitorId}`)
  }
  const startedAt = safeInteger(incident.start[0], `incident.${monitorId}.start`)
  return {
    id: `${monitorId}:${startedAt}`,
    startedAt,
    resolvedAt: nullableSafeInteger(incident.end, `incident.${monitorId}.end`),
    changes: incident.start.map((at, index) => {
      const internalError = stringValue(incident.error[index], `incident.${monitorId}.error`)
      return {
        at: safeInteger(at, `incident.${monitorId}.change.at`),
        internalError,
        publicMessage: publicMessageForInternalError(internalError),
      }
    }),
    downEventKey: null,
    recoveryEventKey: null,
    downNotifiedAt: null,
    recoveryNotifiedAt: null,
  }
}

function validateLatency(
  latency: MonitorStateCompactedV2['latency'][string],
  monitorId: string
): void {
  const locValues = arrayValue(latency.loc?.v, `latency.${monitorId}.loc.v`)
  const locCounts = arrayValue(latency.loc?.c, `latency.${monitorId}.loc.c`)
  if (locValues.length !== locCounts.length) corrupt(`Inconsistent latency RLE columns for ${monitorId}`)
  locValues.forEach((value) => stringValue(value, `latency.${monitorId}.loc.v`))
  const sampleCount = locCounts.reduce<number>(
    (total, value) => total + safeInteger(value, `latency.${monitorId}.loc.c`),
    0
  )
  if (locCounts.some((value) => value === 0)) corrupt(`Invalid zero latency RLE count for ${monitorId}`)
  const ping = decodeUint16(stringValue(latency.ping, `latency.${monitorId}.ping`))
  const time = decodeUint32(stringValue(latency.time, `latency.${monitorId}.time`))
  if (ping.length !== time.length || ping.length !== sampleCount) {
    corrupt(`Inconsistent latency data lengths for ${monitorId}`)
  }
}

function validateChange(value: unknown, monitorId: string, startedAt: number): ErrorChange {
  const change = recordValue(value, `incident.${monitorId}.change`)
  const at = safeInteger(change.at, `incident.${monitorId}.change.at`)
  if (at < startedAt) corrupt(`Incident change precedes start for ${monitorId}`)
  const internalError = stringValue(change.internalError, `incident.${monitorId}.change.internalError`)
  const publicMessage = stringValue(change.publicMessage, `incident.${monitorId}.change.publicMessage`)
  if (publicMessageForInternalError(internalError) !== publicMessage) {
    corrupt(`Inconsistent public incident message for ${monitorId}`)
  }
  return { at, internalError, publicMessage: publicMessage as PublicMessage }
}

function validateV2(state: MonitorStateCompactedV2): MonitorStateCompactedV2 {
  if (!isRecord(state) || state.schemaVersion !== 2) corrupt('Unsupported state schema version')
  safeInteger(state.lastUpdate, 'lastUpdate')
  safeInteger(state.lastRun, 'lastRun')
  safeInteger(state.overallUp, 'overallUp')
  safeInteger(state.overallDown, 'overallDown')
  const monitoringStartedAt = recordValue(state.monitoringStartedAt, 'monitoringStartedAt')
  Object.entries(monitoringStartedAt).forEach(([monitorId, at]) => {
    safeInteger(at, `monitoringStartedAt.${monitorId}`)
  })

  const incidentsByMonitor = recordValue(state.incident, 'incident')
  for (const [monitorId, unknownColumns] of Object.entries(incidentsByMonitor)) {
    const columns = recordValue(unknownColumns, `incident.${monitorId}`)
    const names = [
      'id',
      'startedAt',
      'resolvedAt',
      'changes',
      'downEventKey',
      'recoveryEventKey',
      'downNotifiedAt',
      'recoveryNotifiedAt',
    ] as const
    const values = names.map((name) => arrayValue(columns[name], `incident.${monitorId}.${name}`))
    const count = values[0].length
    if (values.some((value) => value.length !== count)) {
      corrupt(`Inconsistent incident data lengths for ${monitorId}`)
    }
    for (let index = 0; index < count; index++) {
      const startedAt = safeInteger(values[1][index], `incident.${monitorId}.startedAt`)
      const id = stringValue(values[0][index], `incident.${monitorId}.id`)
      if (id !== `${monitorId}:${startedAt}`) corrupt(`Invalid incident id for ${monitorId}`)
      const resolvedAt = nullableSafeInteger(values[2][index], `incident.${monitorId}.resolvedAt`)
      if (resolvedAt !== null && resolvedAt < startedAt) corrupt(`Incident resolves before start for ${monitorId}`)
      const changes = arrayValue(values[3][index], `incident.${monitorId}.changes`)
      if (changes.length === 0) corrupt(`Incident has no changes for ${monitorId}`)
      const validatedChanges = changes.map((change) => validateChange(change, monitorId, startedAt))
      if (validatedChanges[0].at !== startedAt) corrupt(`Incident first change does not match start for ${monitorId}`)
      const downKey = values[4][index] === null
        ? null
        : stringValue(values[4][index], `incident.${monitorId}.downEventKey`)
      const recoveryKey = values[5][index] === null
        ? null
        : stringValue(values[5][index], `incident.${monitorId}.recoveryEventKey`)
      const downNotifiedAt = nullableSafeInteger(values[6][index], `incident.${monitorId}.downNotifiedAt`)
      const recoveryNotifiedAt = nullableSafeInteger(values[7][index], `incident.${monitorId}.recoveryNotifiedAt`)
      if (downKey !== null && downKey !== `${id}:down`) corrupt(`Invalid down event key for ${monitorId}`)
      if (recoveryKey !== null && recoveryKey !== `${id}:recovery`) corrupt(`Invalid recovery event key for ${monitorId}`)
      if (recoveryKey !== null && downKey === null) corrupt(`Recovery event lacks down event for ${monitorId}`)
      if (downNotifiedAt !== null && downKey === null) corrupt(`Down delivery lacks event key for ${monitorId}`)
      if (recoveryNotifiedAt !== null && recoveryKey === null) corrupt(`Recovery delivery lacks event key for ${monitorId}`)
    }
  }

  const latencies = recordValue(state.latency, 'latency')
  for (const [monitorId, latency] of Object.entries(latencies)) {
    const value = recordValue(latency, `latency.${monitorId}`)
    const loc = recordValue(value.loc, `latency.${monitorId}.loc`)
    validateLatency({
      loc: {
        v: arrayValue(loc.v, `latency.${monitorId}.loc.v`) as string[],
        c: arrayValue(loc.c, `latency.${monitorId}.loc.c`) as number[],
      },
      ping: stringValue(value.ping, `latency.${monitorId}.ping`),
      time: stringValue(value.time, `latency.${monitorId}.time`),
    }, monitorId)
  }
  return state
}

function compactLatencyRecords(records: unknown[], monitorId: string): MonitorStateCompactedV2['latency'][string] {
  const result: MonitorStateCompactedV2['latency'][string] = {
    loc: { v: [], c: [] },
    ping: '',
    time: '',
  }
  for (const value of records) {
    const record = recordValue(value, `latency.${monitorId}`)
    const loc = stringValue(record.loc, `latency.${monitorId}.loc`)
    const ping = safeInteger(record.ping, `latency.${monitorId}.ping`)
    const time = safeInteger(record.time, `latency.${monitorId}.time`)
    if (ping > 0xffff || time > 0xffffffff) corrupt(`Latency value outside storage bounds for ${monitorId}`)
    result.ping += encodeUint16(ping)
    result.time += encodeUint32(time)
    if (result.loc.v[result.loc.v.length - 1] === loc) result.loc.c[result.loc.c.length - 1] += 1
    else {
      result.loc.v.push(loc)
      result.loc.c.push(1)
    }
  }
  return result
}

function migrateV1(value: UnknownRecord): MonitorStateCompactedV2 {
  const lastUpdate = safeInteger(value.lastUpdate, 'lastUpdate')
  const state: MonitorStateCompactedV2 = {
    schemaVersion: 2,
    lastUpdate,
    lastRun: lastUpdate,
    overallUp: safeInteger(value.overallUp, 'overallUp'),
    overallDown: safeInteger(value.overallDown, 'overallDown'),
    monitoringStartedAt: {},
    incident: {},
    latency: {},
  }

  const incidentsByMonitor = recordValue(value.incident, 'incident')
  for (const [monitorId, stored] of Object.entries(incidentsByMonitor)) {
    const rows: IncidentRecord[] = []
    if (Array.isArray(stored)) {
      for (const unknownIncident of stored) {
        const incident = recordValue(unknownIncident, `incident.${monitorId}`)
        rows.push({
          start: arrayValue(incident.start, `incident.${monitorId}.start`) as number[],
          end: nullableSafeInteger(incident.end, `incident.${monitorId}.end`),
          error: arrayValue(incident.error, `incident.${monitorId}.error`) as string[],
        })
      }
    } else {
      const columns = recordValue(stored, `incident.${monitorId}`)
      const starts = arrayValue(columns.start, `incident.${monitorId}.start`)
      const ends = arrayValue(columns.end, `incident.${monitorId}.end`)
      const errors = arrayValue(columns.error, `incident.${monitorId}.error`)
      if (starts.length !== ends.length || starts.length !== errors.length) {
        corrupt(`Inconsistent legacy incident data lengths for ${monitorId}`)
      }
      for (let index = 0; index < starts.length; index++) {
        rows.push({
          start: arrayValue(starts[index], `incident.${monitorId}.start`) as number[],
          end: nullableSafeInteger(ends[index], `incident.${monitorId}.end`),
          error: arrayValue(errors[index], `incident.${monitorId}.error`) as string[],
        })
      }
    }

    const columns = emptyIncidentColumns()
    for (const row of rows) {
      if (row.error[0] === 'dummy') {
        if (row.start.length !== 1 || row.error.length !== 1) corrupt(`Invalid dummy incident for ${monitorId}`)
        state.monitoringStartedAt[monitorId] = safeInteger(row.start[0], `monitoringStartedAt.${monitorId}`)
        continue
      }
      appendV2Incident(columns, incidentFromLegacy(monitorId, row))
    }
    if (columns.id.length > 0) state.incident[monitorId] = columns
  }

  const latenciesByMonitor = recordValue(value.latency, 'latency')
  for (const [monitorId, stored] of Object.entries(latenciesByMonitor)) {
    if (Array.isArray(stored)) {
      state.latency[monitorId] = compactLatencyRecords(stored, monitorId)
      continue
    }
    const latency = recordValue(stored, `latency.${monitorId}`)
    const loc = recordValue(latency.loc, `latency.${monitorId}.loc`)
    state.latency[monitorId] = {
      loc: {
        v: arrayValue(loc.v, `latency.${monitorId}.loc.v`) as string[],
        c: arrayValue(loc.c, `latency.${monitorId}.loc.c`) as number[],
      },
      ping: stringValue(latency.ping, `latency.${monitorId}.ping`),
      time: stringValue(latency.time, `latency.${monitorId}.time`),
    }
  }
  return validateV2(state)
}

function dummyIncident(at: number): IncidentRecord {
  return { start: [at], end: at, error: ['dummy'] }
}

export class CompactedMonitorStateWrapper {
  data: MonitorStateCompactedV2

  constructor(compactedStateStr: string | null) {
    if (compactedStateStr === null) {
      this.data = {
        schemaVersion: 2,
        lastUpdate: 0,
        lastRun: 0,
        overallUp: 0,
        overallDown: 0,
        monitoringStartedAt: {},
        incident: {},
        latency: {},
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(compactedStateStr)
    } catch {
      throw new CorruptStateError('Stored state is not valid JSON')
    }
    const state = recordValue(parsed, 'state')
    if (state.schemaVersion === undefined || state.schemaVersion === 1) {
      this.data = migrateV1(state)
    } else if (state.schemaVersion === 2) {
      this.data = validateV2(state as MonitorStateCompactedV2)
    } else {
      throw new CorruptStateError('Unsupported state schema version')
    }
  }

  getCompactedStateStr(): string {
    validateV2(this.data)
    return JSON.stringify(this.data)
  }

  // Legacy view retained until the scheduled orchestrator and frontend use v2 directly.
  uncompact(): MonitorState {
    const state: MonitorState = {
      lastUpdate: this.data.lastUpdate,
      overallUp: this.data.overallUp,
      overallDown: this.data.overallDown,
      monitoringStartedAt: { ...this.data.monitoringStartedAt },
      incident: {},
      latency: {},
    }

    const monitorIds = new Set([
      ...Object.keys(this.data.monitoringStartedAt),
      ...Object.keys(this.data.incident),
    ])
    for (const monitorId of monitorIds) {
      const incidents: IncidentRecord[] = []
      const columns = this.data.incident[monitorId]
      if (columns) {
        for (let index = 0; index < columns.id.length; index++) {
          incidents.push(legacyIncident(incidentAt(columns, index)))
        }
      }
      state.incident[monitorId] = incidents
    }

    for (const [monitorId, latency] of Object.entries(this.data.latency)) {
      const locations: string[] = []
      latency.loc.c.forEach((count, index) => {
        for (let run = 0; run < count; run++) locations.push(latency.loc.v[index])
      })
      const times = decodeUint32(latency.time)
      const pings = decodeUint16(latency.ping)
      state.latency[monitorId] = times.map((time, index) => ({
        time,
        ping: pings[index],
        loc: locations[index],
      }))
    }
    return state
  }

  incidentLen(monitorId: string): number {
    return (this.data.monitoringStartedAt[monitorId] === undefined ? 0 : 1) +
      (this.data.incident[monitorId]?.id.length ?? 0)
  }

  getIncident(monitorId: string, index: number): IncidentRecord {
    const hasDummy = this.data.monitoringStartedAt[monitorId] !== undefined
    if (hasDummy && index === 0) return dummyIncident(this.data.monitoringStartedAt[monitorId])
    const columns = this.data.incident[monitorId]
    const v2Index = index - (hasDummy ? 1 : 0)
    if (!columns || v2Index < 0 || v2Index >= columns.id.length) {
      throw new Error('Index out of bounds or monitor not found')
    }
    return legacyIncident(incidentAt(columns, v2Index))
  }

  setIncident(monitorId: string, index: number, incident: IncidentRecord): void {
    const hasDummy = this.data.monitoringStartedAt[monitorId] !== undefined
    if (hasDummy && index === 0) {
      if (incident.error[0] !== 'dummy' || incident.start.length !== 1) {
        throw new Error('Legacy monitoring marker must remain a dummy incident')
      }
      this.data.monitoringStartedAt[monitorId] = safeInteger(incident.start[0], `monitoringStartedAt.${monitorId}`)
      return
    }
    const columns = this.data.incident[monitorId]
    const v2Index = index - (hasDummy ? 1 : 0)
    if (!columns || v2Index < 0 || v2Index >= columns.id.length) {
      throw new Error('Index out of bounds or monitor not found')
    }
    const previous = incidentAt(columns, v2Index)
    const replacement = incidentFromLegacy(monitorId, incident)
    columns.id[v2Index] = previous.id
    columns.startedAt[v2Index] = previous.startedAt
    columns.resolvedAt[v2Index] = replacement.resolvedAt
    columns.changes[v2Index] = replacement.changes
    columns.downEventKey[v2Index] = previous.downEventKey
    columns.recoveryEventKey[v2Index] = previous.recoveryEventKey
    columns.downNotifiedAt[v2Index] = previous.downNotifiedAt
    columns.recoveryNotifiedAt[v2Index] = previous.recoveryNotifiedAt
  }

  appendIncident(monitorId: string, incident: IncidentRecord): void {
    if (incident.error[0] === 'dummy') {
      if (incident.start.length !== 1 || incident.error.length !== 1) {
        throw new CorruptStateError(`Invalid dummy incident for ${monitorId}`)
      }
      this.data.monitoringStartedAt[monitorId] = safeInteger(incident.start[0], `monitoringStartedAt.${monitorId}`)
      return
    }
    const columns = this.data.incident[monitorId] ??= emptyIncidentColumns()
    appendV2Incident(columns, incidentFromLegacy(monitorId, incident))
  }

  shiftIncident(monitorId: string): void {
    if (this.data.monitoringStartedAt[monitorId] !== undefined) {
      delete this.data.monitoringStartedAt[monitorId]
      return
    }
    const columns = this.data.incident[monitorId]
    if (!columns || columns.id.length === 0) throw new Error('Monitor has no incidents')
    for (const values of Object.values(columns)) values.shift()
    if (columns.id.length === 0) delete this.data.incident[monitorId]
  }

  unshiftIncident(monitorId: string, incident: IncidentRecord): void {
    if (incident.error[0] === 'dummy') {
      if (incident.start.length !== 1 || incident.error.length !== 1) {
        throw new CorruptStateError(`Invalid dummy incident for ${monitorId}`)
      }
      this.data.monitoringStartedAt[monitorId] = safeInteger(incident.start[0], `monitoringStartedAt.${monitorId}`)
      return
    }
    const columns = this.data.incident[monitorId] ??= emptyIncidentColumns()
    appendV2Incident(columns, incidentFromLegacy(monitorId, incident), true)
  }

  latencyLen(monitorId: string): number {
    return this.data.latency[monitorId]?.ping.length / 4 || 0
  }

  appendLatency(monitorId: string, record: LatencyRecord): void {
    const time = safeInteger(record.time, `latency.${monitorId}.time`)
    const ping = safeInteger(record.ping, `latency.${monitorId}.ping`)
    if (time > 0xffffffff || ping > 0xffff) {
      throw new RangeError('Latency value is outside compacted storage bounds')
    }
    const latencies = this.data.latency[monitorId] ??= {
      time: '',
      ping: '',
      loc: { c: [], v: [] },
    }
    latencies.time += encodeUint32(time)
    latencies.ping += encodeUint16(ping)
    if (latencies.loc.v[latencies.loc.v.length - 1] !== record.loc) {
      latencies.loc.c.push(1)
      latencies.loc.v.push(record.loc)
    } else {
      latencies.loc.c[latencies.loc.c.length - 1] += 1
    }
  }

  getFirstLatency(monitorId: string): LatencyRecord {
    const latencies = this.data.latency[monitorId]
    if (!latencies || latencies.time === '') return { time: 0, ping: 0, loc: '' }
    return {
      time: decodeUint32(latencies.time.slice(0, 8))[0],
      ping: decodeUint16(latencies.ping.slice(0, 4))[0],
      loc: latencies.loc.v[0],
    }
  }

  getLastLatency(monitorId: string): LatencyRecord {
    const latencies = this.data.latency[monitorId]
    if (!latencies || latencies.time === '') return { time: 0, ping: 0, loc: '' }
    return {
      time: decodeUint32(latencies.time.slice(-8))[0],
      ping: decodeUint16(latencies.ping.slice(-4))[0],
      loc: latencies.loc.v[latencies.loc.v.length - 1],
    }
  }

  unshiftLatency(monitorId: string): void {
    const latencies = this.data.latency[monitorId]
    if (!latencies || latencies.time === '') throw new Error('Monitor has no latency records')
    latencies.time = latencies.time.slice(8)
    latencies.ping = latencies.ping.slice(4)
    latencies.loc.c[0] -= 1
    if (latencies.loc.c[0] === 0) {
      latencies.loc.c.shift()
      latencies.loc.v.shift()
    }
  }
}
