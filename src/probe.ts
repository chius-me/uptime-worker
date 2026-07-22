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
const MAX_PROXY_PING = 300_000

export class ResponseTooLargeError extends Error {
  constructor(readonly partialText: string) {
    super('Response body exceeds size limit')
    this.name = 'ResponseTooLargeError'
  }
}

export async function readTextLimited(response: Response, maxBytes = 65_536): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer')
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let completed = false
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
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
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
    typeof status.ping !== 'number' ||
    !Number.isFinite(status.ping) ||
    status.ping < 0 ||
    status.ping > MAX_PROXY_PING ||
    typeof status.up !== 'boolean' ||
    typeof status.internalError !== 'string' ||
    status.internalError.length > MAX_INTERNAL_ERROR_LENGTH ||
    typeof status.publicMessage !== 'string' ||
    !PUBLIC_MESSAGES.has(status.publicMessage as PublicMessage)
  ) {
    throw new TypeError('Invalid proxy status')
  }
  if (
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

export function failedProbe(
  publicMessage: Exclude<PublicMessage, 'OK' | 'Not checked yet'>,
  internalError: string,
  ping = 0
): ProbeStatus {
  return { ping, up: false, internalError: internalError.slice(0, MAX_INTERNAL_ERROR_LENGTH), publicMessage }
}

export function successfulProbe(ping: number): ProbeStatus {
  return { ping, up: true, internalError: '', publicMessage: 'OK' }
}
