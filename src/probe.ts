import type { PublicMessage } from '../types/config'

export type ProbeStatus = {
  ping: number
  up: boolean
  internalError: string
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

const MAX_LOCATION_LENGTH = 256
const MAX_INTERNAL_ERROR_LENGTH = 512
export const MAX_PROBE_PING = 65_535

export class ProbeTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`Probe deadline exceeded after ${milliseconds}ms`)
    this.name = 'AbortError'
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly partialText: string) {
    super('Response body exceeds size limit')
    this.name = 'ResponseTooLargeError'
  }
}

export async function readTextLimited(
  response: Response,
  maxBytes = 65_536,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer')
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let completed = false
  const cancelOnAbort = () => {
    try {
      void reader.cancel(signal?.reason).catch(() => undefined)
    } catch {
      // Cancellation must not replace the probe result.
    }
  }
  if (signal?.aborted) cancelOnAbort()
  else signal?.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        return text + decoder.decode()
      }
      const remaining = maxBytes - bytesRead
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true })
        throw new ResponseTooLargeError(text + decoder.decode())
      }
      bytesRead += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort)
    if (!completed) {
      try {
        void reader.cancel().catch(() => undefined)
      } catch {
        // Cancellation must not replace the body result or error.
      }
    }
    try {
      reader.releaseLock()
    } catch {
      // Releasing a reader is best-effort cleanup.
    }
  }
}

export async function fetchAndConsumeWithTimeout<T>(
  url: string,
  milliseconds: number,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  { signal: parentSignal, ...options }: RequestInit<RequestInitCfProperties> = {}
): Promise<T> {
  const controller = new AbortController()
  let response: Response | undefined
  let timeoutError: ProbeTimeoutError | undefined
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = new ProbeTimeoutError(milliseconds)
      controller.abort(timeoutError)
      reject(timeoutError)
    }, milliseconds)
  })

  try {
    response = await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      deadline,
    ])
    try {
      const value = await Promise.race([consume(response, controller.signal), deadline])
      if (controller.signal.aborted) throw timeoutError ?? controller.signal.reason
      return value
    } catch (error) {
      if (timeoutError) throw timeoutError
      throw error
    }
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent)
    if (!controller.signal.aborted) controller.abort()
    try {
      void response?.body?.cancel().catch(() => undefined)
    } catch {
      // Cancellation must not replace the fetch result or error.
    }
    clearTimeout(timer!)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

export function parseProxyResult(value: unknown): { location: string; status: ProbeStatus } {
  if (!isRecord(value) || !hasOnlyKeys(value, ['location', 'status'])) {
    throw new TypeError('Invalid proxy result')
  }
  if (
    typeof value.location !== 'string' ||
    value.location.length < 1 ||
    value.location.length > MAX_LOCATION_LENGTH
  ) {
    throw new TypeError('Invalid proxy location')
  }
  const status = value.status
  if (
    !isRecord(status) ||
    !hasOnlyKeys(status, ['ping', 'up', 'internalError', 'publicMessage']) ||
    !isProbePing(status.ping) ||
    typeof status.up !== 'boolean' ||
    typeof status.internalError !== 'string' ||
    status.internalError.length > MAX_INTERNAL_ERROR_LENGTH ||
    typeof status.publicMessage !== 'string' ||
    !PUBLIC_MESSAGES.has(status.publicMessage as PublicMessage)
  ) {
    throw new TypeError('Invalid proxy status')
  }
  if (
    status.publicMessage !== publicMessageForInternalError(status.internalError) ||
    (status.up && (status.publicMessage !== 'OK' || status.internalError !== '')) ||
    (!status.up && (
      status.publicMessage === 'OK' ||
      status.publicMessage === 'Not checked yet' ||
      status.internalError.length === 0
    ))
  ) {
    throw new TypeError('Inconsistent proxy status')
  }

  return {
    location: value.location,
    status: {
      ping: status.ping,
      up: status.up,
      internalError: status.internalError,
      publicMessage: status.publicMessage as PublicMessage,
    },
  }
}

export function boundedError(error: unknown, fallback: string): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return (value || fallback).slice(0, MAX_INTERNAL_ERROR_LENGTH)
}

export function publicMessageForInternalError(internalError: string): PublicMessage {
  if (internalError === '') return 'OK'
  if (internalError.startsWith('Timeout:')) return 'Timeout'
  if (internalError.startsWith('Unexpected status:')) return 'Unexpected status code'
  if (internalError.startsWith('TLS validation:')) return 'TLS validation failed'
  if (internalError.startsWith('Content check inconclusive:')) return 'Content check inconclusive'
  if (internalError.startsWith('Content check:')) return 'Content check failed'
  if (internalError.startsWith('Connection:')) return 'Connection failed'
  if (/timeout|abort/i.test(internalError)) return 'Timeout'
  if (/status|expected code/i.test(internalError)) return 'Unexpected status code'
  if (/tls|certificate/i.test(internalError)) return 'TLS validation failed'
  if (/inconclusive/i.test(internalError)) return 'Content check inconclusive'
  if (/keyword|content check/i.test(internalError)) return 'Content check failed'
  return 'Connection failed'
}

export function isProbePing(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_PROBE_PING
}

function requireProbePing(value: number): number {
  if (!isProbePing(value)) throw new TypeError('Probe ping is outside Uint16 storage bounds')
  return value
}

export function failedProbe(internalError: string, ping = 0): ProbeStatus {
  const bounded = internalError.slice(0, MAX_INTERNAL_ERROR_LENGTH)
  const publicMessage = publicMessageForInternalError(bounded)
  if (publicMessage === 'OK' || publicMessage === 'Not checked yet') {
    throw new TypeError('A failed probe requires an internal diagnostic')
  }
  return { ping: requireProbePing(ping), up: false, internalError: bounded, publicMessage }
}

export function successfulProbe(ping: number): ProbeStatus {
  const internalError = ''
  return {
    ping: requireProbePing(ping),
    up: true,
    internalError,
    publicMessage: publicMessageForInternalError(internalError),
  }
}
