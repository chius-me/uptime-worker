import type { Env } from './index'
import type { MonitorTarget } from '../types/config'
import { withTimeout } from './util'
import { logEvent } from './log'
import {
  ResponseTooLargeError,
  boundedError,
  failedProbe,
  fetchAndConsumeWithTimeout,
  isProbePing,
  parseProxyResult,
  readTextLimited,
  successfulProbe,
  type ProbeStatus,
} from './probe'

interface GlobalPingMeasurementResponse {
  id: string
  error?: { message: string }
}

interface GlobalPingResult {
  status: string
  results: Array<{
    probe: { country: string; city: string }
    result: {
      status: string
      stats?: { avg: number }
      timings?: { total: number }
      statusCode?: number
      rawBody?: string
      tls?: { authorized: boolean }
    }
  }>
}

type SocketLike = { opened: Promise<unknown>; close(): Promise<unknown> }
type ProbeDependencies = {
  connect?: (address: { hostname: string; port: number }) => SocketLike
}

type CheckFailure = { internalError: string }

const DEFAULT_TIMEOUT = 10_000

function isCredentialHeader(header: string): boolean {
  const compact = header.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [
    'authorization',
    'cookie',
    'apikey',
    'token',
    'secret',
    'credential',
    'password',
    'session',
  ].some((credential) => compact.includes(credential))
}

function globalPingHeaders(monitor: MonitorTarget): Record<string, string> {
  const allowed = new Set((monitor.forwardHeaders ?? []).map((header) => header.toLowerCase()))
  return Object.fromEntries(
    Object.entries(monitor.headers ?? {})
      .filter(([header]) => allowed.has(header.toLowerCase()) && !isCredentialHeader(header))
      .map(([header, value]) => [header, String(value)])
  )
}

function isIpAddress(hostname: string): boolean {
  if (hostname.includes(':')) return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function getDomainOnlyIpVersionOption(hostname: string, gpUrl: URL): { ipVersion?: number } {
  return isIpAddress(hostname) ? {} : { ipVersion: Number(gpUrl.searchParams.get('ipVersion') || 4) }
}

function isTimeout(error: unknown): boolean {
  return (error instanceof Error && error.name === 'AbortError') ||
    String(error).toLowerCase().includes('timed out') ||
    String(error).toLowerCase().includes('timeout')
}

function connectionDiagnostic(error: unknown, fallback: string): string {
  return `Connection: ${boundedError(error, fallback)}`
}

function timeoutDiagnostic(error: unknown, fallback: string): string {
  return `Timeout: ${boundedError(error, fallback)}`
}

async function httpResponseBasicCheck(
  monitor: MonitorTarget,
  code: number,
  bodyReader: () => Promise<string>
): Promise<CheckFailure | null> {
  if (monitor.expectedCodes ? !monitor.expectedCodes.includes(code) : code < 200 || code > 299) {
    return {
      internalError: 'Unexpected status: ' + (monitor.expectedCodes
        ? `expected ${JSON.stringify(monitor.expectedCodes)}, got ${code}`
        : `expected 2xx, got ${code}`),
    }
  }

  if (!monitor.responseKeyword && !monitor.responseForbiddenKeyword) return null

  let responseBody: string
  try {
    responseBody = await bodyReader()
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      const requiredFound = !monitor.responseKeyword || error.partialText.includes(monitor.responseKeyword)
      if (requiredFound && !monitor.responseForbiddenKeyword) return null
      return { internalError: 'Content check inconclusive: response exceeded 65536 bytes' }
    }
    throw error
  }

  if (monitor.responseKeyword && !responseBody.includes(monitor.responseKeyword)) {
    return { internalError: 'Content check: required keyword missing' }
  }
  if (monitor.responseForbiddenKeyword && responseBody.includes(monitor.responseForbiddenKeyword)) {
    return { internalError: 'Content check: forbidden keyword present' }
  }
  return null
}

async function readJsonLimited(response: Response, signal: AbortSignal): Promise<unknown> {
  const text = await readTextLimited(response, 65_536, signal)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON response')
  }
}

function asGlobalPingMeasurement(value: unknown): GlobalPingMeasurementResponse {
  if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('Invalid Globalping measurement response')
  }
  return value as GlobalPingMeasurementResponse
}

function asGlobalPingResult(value: unknown): GlobalPingResult {
  if (
    typeof value !== 'object' || value === null ||
    typeof (value as { status?: unknown }).status !== 'string' ||
    !Array.isArray((value as { results?: unknown }).results)
  ) {
    throw new Error('Invalid Globalping result')
  }
  return value as GlobalPingResult
}

function probePing(value: unknown, field: string): number {
  if (!isProbePing(value)) {
    throw new Error(`Invalid Globalping ${field}`)
  }
  return value as number
}

function globalPingStatusCode(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    throw new Error('Invalid Globalping status code')
  }
  return value as number
}

function globalPingLocation(result: GlobalPingResult['results'][number]): string {
  const { country, city } = result.probe ?? {}
  if (
    typeof country !== 'string' || country.length < 1 || country.length > 64 ||
    typeof city !== 'string' || city.length < 1 || city.length > 64
  ) {
    throw new Error('Invalid Globalping location')
  }
  return `${country}/${city}`
}

export async function getStatusWithGlobalPing(
  monitor: MonitorTarget
): Promise<{ location: string; status: ProbeStatus }> {
  const timeout = monitor.timeout ?? DEFAULT_TIMEOUT
  let measurementId = 'unknown'
  const probeStart = Date.now()
  try {
    if (monitor.checkProxy === undefined) throw new Error('Missing Globalping proxy')
    const gpUrl = new URL(monitor.checkProxy)
    if (gpUrl.protocol !== 'globalping:') throw new Error('Invalid Globalping proxy')

    const token = gpUrl.hostname
    let globalPingRequest: Record<string, unknown>
    if (monitor.method === 'TCP_PING') {
      const targetUrl = new URL(`https://${monitor.target}`)
      globalPingRequest = {
        type: 'ping',
        target: targetUrl.hostname,
        locations: gpUrl.searchParams.has('magic') ? [{ magic: gpUrl.searchParams.get('magic') }] : undefined,
        measurementOptions: {
          port: targetUrl.port,
          packets: 1,
          protocol: 'tcp',
          ...getDomainOnlyIpVersionOption(targetUrl.hostname, gpUrl),
        },
      }
    } else {
      const targetUrl = new URL(monitor.target)
      if (monitor.body !== undefined) throw new Error('Globalping custom body is unsupported')
      if (monitor.method && !['GET', 'HEAD', 'OPTIONS'].includes(monitor.method.toUpperCase())) {
        throw new Error('Unsupported Globalping method')
      }
      globalPingRequest = {
        type: 'http',
        target: targetUrl.hostname,
        locations: gpUrl.searchParams.has('magic') ? [{ magic: gpUrl.searchParams.get('magic') }] : undefined,
        measurementOptions: {
          request: {
            method: monitor.method,
            path: targetUrl.pathname,
            query: targetUrl.search || undefined,
            headers: globalPingHeaders(monitor),
          },
          port: targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443),
          protocol: targetUrl.protocol.slice(0, -1),
          ...getDomainOnlyIpVersionOption(targetUrl.hostname, gpUrl),
        },
      }
    }

    const deadline = probeStart + timeout
    const measurement = await fetchAndConsumeWithTimeout(
      'https://api.globalping.io/v1/measurements',
      Math.max(1, Math.min(5000, deadline - Date.now())),
      async (response, signal) => {
        if (response.status !== 202) throw new Error('Globalping measurement rejected')
        return asGlobalPingMeasurement(await readJsonLimited(response, signal))
      },
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(globalPingRequest),
      }
    )
    measurementId = measurement.id.slice(0, 128)
    logEvent('globalping_measurement', {
      measurementId,
      status: 'created',
      duration: Date.now() - probeStart,
    })

    let measurementResult: GlobalPingResult
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Globalping polling timeout')
      measurementResult = await fetchAndConsumeWithTimeout(
        `https://api.globalping.io/v1/measurements/${encodeURIComponent(measurementId)}`,
        Math.max(1, Math.min(5000, remaining)),
        async (response, signal) => {
          if (!response.ok) throw new Error('Globalping polling failed')
          return asGlobalPingResult(await readJsonLimited(response, signal))
        }
      )
      if (measurementResult.status !== 'in-progress') break
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))))
    }

    logEvent('globalping_measurement', {
      measurementId,
      status: measurementResult.status.slice(0, 32),
      duration: Date.now() - probeStart,
    })

    const first = measurementResult.results[0]
    if (measurementResult.status !== 'finished' || !first || first.result?.status !== 'finished') {
      throw new Error('Globalping measurement failed')
    }
    const location = globalPingLocation(first)

    if (monitor.method === 'TCP_PING') {
      return { location, status: successfulProbe(probePing(first.result.stats?.avg, 'latency')) }
    }

    const ping = probePing(first.result.timings?.total, 'latency')
    const code = globalPingStatusCode(first.result.statusCode)
    const checkFailure = await httpResponseBasicCheck(monitor, code, async () => {
      const body = first.result.rawBody ?? ''
      if (typeof body !== 'string') throw new Error('Invalid Globalping body')
      if (new TextEncoder().encode(body).byteLength > 65_536) {
        throw new ResponseTooLargeError(body.slice(0, 65_536))
      }
      return body
    })
    if (checkFailure) {
      logEvent('response_check_failed', { monitorId: monitor.id })
      return { location, status: failedProbe(checkFailure.internalError, ping) }
    }
    if (monitor.target.toLowerCase().startsWith('https') && !first.result.tls?.authorized) {
      logEvent('tls_certificate_untrusted', { monitorId: monitor.id })
      return { location, status: failedProbe('TLS validation: certificate not trusted', ping) }
    }
    return { location, status: successfulProbe(ping) }
  } catch (error) {
    const timedOut = isTimeout(error)
    logEvent('globalping_measurement', {
      measurementId,
      status: timedOut ? 'timeout' : 'failed',
      duration: Date.now() - probeStart,
    })
    return {
      location: 'ERROR',
      status: failedProbe(
        timedOut
          ? timeoutDiagnostic(error, 'Globalping deadline exceeded')
          : connectionDiagnostic(error, 'Globalping error'),
        timedOut ? timeout : 0
      ),
    }
  }
}

export async function getStatus(
  monitor: MonitorTarget,
  dependencies: ProbeDependencies = {}
): Promise<ProbeStatus> {
  const timeout = monitor.timeout ?? DEFAULT_TIMEOUT
  const startTime = Date.now()

  if (monitor.method === 'TCP_PING') {
    let socket: SocketLike | undefined
    try {
      const connect = dependencies.connect ?? await import(/* webpackIgnore: true */ 'cloudflare:sockets').then(
        (sockets) => sockets.connect as unknown as ProbeDependencies['connect']
      )
      const parsed = new URL(`https://${monitor.target}`)
      socket = connect!({ hostname: parsed.hostname, port: Number(parsed.port) })
      await withTimeout(timeout, socket.opened)
      logEvent('tcp_connection_succeeded', { monitorId: monitor.id })
      return successfulProbe(Date.now() - startTime)
    } catch (error) {
      const timedOut = isTimeout(error)
      logEvent('tcp_connection_failed', { monitorId: monitor.id })
      return failedProbe(
        timedOut
          ? timeoutDiagnostic(error, 'TCP connection deadline exceeded')
          : connectionDiagnostic(error, 'TCP connection error'),
        timedOut ? timeout : 0
      )
    } finally {
      try {
        void socket?.close().catch(() => undefined)
      } catch {
        // Socket cleanup must not delay or replace the probe result.
      }
    }
  }

  try {
    const headers = new Headers(monitor.headers as HeadersInit | undefined)
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'UptimeFlare/1.0 (+https://github.com/lyc8503/UptimeFlare)')
    }
    return await fetchAndConsumeWithTimeout(
      monitor.target,
      timeout,
      async (response, signal) => {
        logEvent('http_response_received', { monitorId: monitor.id, status: response.status })
        const checkFailure = await httpResponseBasicCheck(
          monitor,
          response.status,
          () => readTextLimited(response, 65_536, signal)
        )
        const ping = Date.now() - startTime
        if (checkFailure) {
          logEvent('response_check_failed', { monitorId: monitor.id })
          return failedProbe(checkFailure.internalError, ping)
        }
        return successfulProbe(ping)
      },
      {
        method: monitor.method,
        headers,
        body: monitor.body,
        cf: { cacheTtlByStatus: { '100-599': -1 } },
      }
    )
  } catch (error) {
    const timedOut = isTimeout(error)
    logEvent('http_request_failed', { monitorId: monitor.id })
    return failedProbe(
      timedOut
        ? timeoutDiagnostic(error, 'HTTP request deadline exceeded')
        : connectionDiagnostic(error, 'HTTP request error'),
      timedOut ? timeout : 0
    )
  }
}

export function remoteCheckerName(monitorId: string, location: string): string {
  return `${monitorId}:${location}`
}

function proxyDto(monitor: MonitorTarget) {
  return {
    method: monitor.method,
    target: monitor.target,
    timeout: monitor.timeout ?? DEFAULT_TIMEOUT,
    expectedCodes: monitor.expectedCodes,
    responseKeyword: monitor.responseKeyword,
    responseForbiddenKeyword: monitor.responseForbiddenKeyword,
  }
}

function customProxyAllowed(monitor: MonitorTarget, allowedHosts?: string[]): boolean {
  const proxy = new URL(monitor.checkProxy!)
  const allowlist = monitor.checkProxyAllowedHosts ?? allowedHosts ?? []
  return (proxy.protocol === 'http:' || proxy.protocol === 'https:') &&
    allowlist.some((host) => host.toLowerCase() === proxy.hostname.toLowerCase())
}

async function customProxyMonitor(monitor: MonitorTarget, allowedHosts?: string[]) {
  if (!customProxyAllowed(monitor, allowedHosts)) throw new Error('Custom proxy host is not allowed')
  return fetchAndConsumeWithTimeout(
    monitor.checkProxy!,
    monitor.timeout ?? DEFAULT_TIMEOUT,
    async (response, signal) => {
      if (response.status >= 300 && response.status <= 399) {
        throw new Error('Custom proxy redirect rejected')
      }
      if (!response.ok) throw new Error('Custom proxy request failed')
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
        throw new Error('Custom proxy returned non-JSON content')
      }
      return parseProxyResult(await readJsonLimited(response, signal))
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyDto(monitor)),
      redirect: 'manual',
    }
  )
}

export async function doMonitor(
  monitor: MonitorTarget,
  defaultLocation: string,
  env: Env,
  options: { allowedHosts?: string[] } = {}
): Promise<{ location: string; status: ProbeStatus; id: string }> {
  let location = defaultLocation
  let status: ProbeStatus

  if (!monitor.checkProxy) {
    status = await getStatus(monitor)
  } else {
    try {
      logEvent('proxy_check_started', { monitorId: monitor.id })
      if (monitor.checkProxy.startsWith('worker://')) {
        const doLoc = monitor.checkProxy.slice('worker://'.length)
        const doId = env.REMOTE_CHECKER_DO.idFromName(remoteCheckerName(monitor.id, doLoc))
        const doStub = env.REMOTE_CHECKER_DO.get(doId, { locationHint: doLoc as DurableObjectLocationHint })
        const remote = await withTimeout(
          monitor.timeout ?? DEFAULT_TIMEOUT,
          doStub.getLocationAndStatus(monitor)
        )
        const parsed = parseProxyResult(remote)
        location = parsed.location
        status = parsed.status
      } else if (monitor.checkProxy.startsWith('globalping://')) {
        const remote = await getStatusWithGlobalPing(monitor)
        location = remote.location
        status = remote.status
      } else {
        const remote = await customProxyMonitor(monitor, options.allowedHosts)
        location = remote.location
        status = remote.status
      }
    } catch (error) {
      logEvent('proxy_check_failed', { monitorId: monitor.id })
      if (monitor.checkProxyFallback) {
        logEvent('proxy_check_fallback', { monitorId: monitor.id })
        status = await getStatus(monitor)
      } else {
        const timedOut = isTimeout(error)
        status = failedProbe(
          timedOut
            ? timeoutDiagnostic(error, 'Check proxy deadline exceeded')
            : connectionDiagnostic(error, 'Check proxy error'),
          timedOut ? monitor.timeout ?? DEFAULT_TIMEOUT : 0
        )
      }
    }
  }

  logEvent('monitor_check_result', { monitorId: monitor.id, up: status.up, ping: status.ping })
  return { location, status, id: monitor.id }
}
