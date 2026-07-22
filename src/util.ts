import { MonitorTarget, WebhookConfig, WorkerConfig } from '../types/config'
import { maintenances } from '../uptime.config'
import { logEvent } from './log'

import type { Env } from './index'

async function getWorkerLocation() {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace')
  const text = await res.text()

  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  return colo
}

const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const promise = fetch(url, { signal: controller.signal, ...options })
  if (signal) signal.addEventListener('abort', () => controller.abort())
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => clearTimeout(timeout))
}

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  const timeout = new Promise<T>((resolve, reject) =>
    setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  )

  return Promise.race([promise, timeout])
}

function formatStatusChangeNotification(
  monitor: MonitorTarget,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string,
  timeZone: string
) {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone,
  })

  let downtimeDuration = Math.round((timeNow - timeIncidentStart) / 60)
  const timeNowFormatted = dateFormatter.format(new Date(timeNow * 1000))
  const timeIncidentStartFormatted = dateFormatter.format(new Date(timeIncidentStart * 1000))

  if (isUp) {
    return `🟢 ${monitor.name} is up! \nThe service is up again after being down for ${downtimeDuration} minutes.`
  } else if (timeNow == timeIncidentStart) {
    return `🔴 ${monitor.name
      } is currently down. \nService is unavailable at ${timeNowFormatted}. \nIssue: ${reason || 'unspecified'
      }`
  } else {
    return `🔴 ${monitor.name
      } is still down. \nService is unavailable since ${timeIncidentStartFormatted} (${downtimeDuration} minutes). \nIssue: ${reason || 'unspecified'
      }`
  }
}

function templateWebhookPayload(payload: Record<string, unknown>, message: string) {
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      if (payload[key] === '$MSG') {
        payload[key] = message
      } else if (typeof payload[key] === 'object' && payload[key] !== null) {
        templateWebhookPayload(payload[key] as Record<string, unknown>, message)
      }
    }
  }
}

async function webhookNotify(_env: Env, webhook: WebhookConfig, message: string) {
  if (Array.isArray(webhook)) {
    for (const w of webhook) {
      await webhookNotify(_env, w, message)
    }
    return
  }

  const host = new URL(webhook.url).hostname
  const startTime = Date.now()
  let method = webhook.method ?? 'UNKNOWN'
  let status: number | null = null
  try {
    let url = webhook.url

    let headers = new Headers(webhook.headers as any)
    let payloadTemplated: { [key: string]: string | number } = JSON.parse(
      JSON.stringify(webhook.payload)
    )

    templateWebhookPayload(payloadTemplated as unknown as Record<string, unknown>, message)
    let body = undefined

    switch (webhook.payloadType) {
      case 'param':
        method = webhook.method ?? 'GET'
        const urlTmp = new URL(url)
        for (const [k, v] of Object.entries(payloadTemplated)) {
          urlTmp.searchParams.append(k, v.toString())
        }
        url = urlTmp.toString()
        break
      case 'json':
        method = webhook.method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/json')
        }
        body = JSON.stringify(payloadTemplated)
        break
      case 'x-www-form-urlencoded':
        method = webhook.method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/x-www-form-urlencoded')
        }
        body = new URLSearchParams(payloadTemplated as any).toString()
        break
      default:
        throw 'Unrecognized payload type: ' + webhook.payloadType
    }

    const resp = await fetchTimeout(url, webhook.timeout ?? 5000, { method, headers, body })
    status = resp.status

    logEvent('webhook_response', {
      host,
      method,
      status,
      duration: Date.now() - startTime,
    })
    if (!resp.ok) {
      throw new Error('Webhook request failed')
    }
  } catch {
    if (status === null) {
      logEvent('webhook_request_failed', {
        host,
        method,
        status,
        duration: Date.now() - startTime,
      })
    }
    throw new Error('Webhook request failed')
  }
}

// Auxiliary function to format notification and send it via webhook
const formatAndNotify = async (
  env: Env,
  config: WorkerConfig,
  monitor: MonitorTarget,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string
) => {
  // Skip notification if monitor is in the skip list
  const skipList = config.notification?.skipNotificationIds
  if (skipList && skipList.includes(monitor.id)) {
    logEvent('notification_skipped', { monitorId: monitor.id, reason: 'skip_list' })
    return
  }

  // Skip notification if monitor is in maintenance
  const maintenanceList = maintenances
    .filter(
      (m) =>
        new Date(timeNow * 1000) >= new Date(m.start) &&
        (!m.end || new Date(timeNow * 1000) <= new Date(m.end))
    )
    .map((e) => e.monitors || [])
    .flat()

  if (maintenanceList.includes(monitor.id)) {
    logEvent('notification_skipped', { monitorId: monitor.id, reason: 'maintenance' })
    return
  }

  if (config.notification?.webhook) {
    const notification = formatStatusChangeNotification(
      monitor,
      isUp,
      timeIncidentStart,
      timeNow,
      reason,
      config.notification?.timeZone ?? 'Etc/GMT'
    )
    await webhookNotify(env, config.notification.webhook, notification)
  } else {
    logEvent('notification_skipped', { monitorId: monitor.id, reason: 'webhook_not_configured' })
  }
}

export {
  getWorkerLocation,
  fetchTimeout,
  withTimeout,
  webhookNotify,
  formatStatusChangeNotification,
  formatAndNotify,
}
