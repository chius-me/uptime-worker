import type { WebhookConfig, WorkerConfig } from '../types/config'

const PLACEHOLDER = /<([A-Z0-9_]+)>/g
const MIN_TIMEOUT = 1
const MAX_TIMEOUT = 30000
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'worker:', 'globalping:'])

export function resolveConfigValue<T>(value: T, env: Record<string, unknown>, path = 'config'): T {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_match, key: string) => {
      const resolved = env[key]
      if (resolved === undefined || resolved === null || resolved === '') {
        throw new Error(`Unresolved secret ${key} at ${path}`)
      }
      return String(resolved)
    }) as T
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveConfigValue(item, env, `${path}[${index}]`)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveConfigValue(item, env, `${path}.${key}`)])
    ) as T
  }
  return value
}

function validateTimeout(timeout: number | undefined, path: string) {
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT)) {
    throw new Error(`Invalid timeout at ${path}`)
  }
}

function validateWebhook(webhook: WebhookConfig, path: string) {
  if (Array.isArray(webhook)) {
    webhook.forEach((item, index) => validateWebhook(item, `${path}[${index}]`))
    return
  }

  let url: URL
  try {
    url = new URL(webhook.url)
  } catch {
    throw new Error(`Invalid webhook URL at ${path}.url`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Webhook URL must use HTTPS at ${path}.url`)
  }
  validateTimeout(webhook.timeout, `${path}.timeout`)
}

export function validateAndResolveConfig(
  config: WorkerConfig,
  env: Record<string, unknown>
): WorkerConfig {
  const resolvedConfig = resolveConfigValue(config, env)
  const monitorIds = new Set<string>()

  resolvedConfig.monitors.forEach((monitor, index) => {
    if (monitorIds.has(monitor.id)) {
      throw new Error(`Duplicate monitor id: ${monitor.id}`)
    }
    monitorIds.add(monitor.id)
    validateTimeout(monitor.timeout, `monitors[${index}].timeout`)

    if (monitor.checkProxy !== undefined) {
      let proxyUrl: URL
      try {
        proxyUrl = new URL(monitor.checkProxy)
      } catch {
        throw new Error(`Invalid proxy URL at monitors[${index}].checkProxy`)
      }
      if (!PROXY_PROTOCOLS.has(proxyUrl.protocol)) {
        throw new Error(`Invalid proxy URL at monitors[${index}].checkProxy`)
      }
    }
  })

  if (resolvedConfig.notification?.webhook) {
    validateWebhook(resolvedConfig.notification.webhook, 'notification.webhook')
  }

  return resolvedConfig
}
