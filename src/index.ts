import { DurableObject } from 'cloudflare:workers'
import { MonitorTarget } from '../types/config'
import { workerConfig, maintenances, pageConfig } from '../uptime.config'
import { doMonitor, getStatus } from './monitor'
import { formatAndNotify, getWorkerLocation } from './util'
import { validateAndResolveConfig } from './config'
import { logEvent } from './log'
import { CompactedMonitorStateWrapper, getFromStore, setToStore } from './store'
import { isBasicAuthValid } from './auth'
import { buildDataPayload, handleBadgeAPI, handleHealthAPI } from './api'
import { withSecurityHeaders } from './security'
import type { ProbeStatus } from './probe'
import pLimit from 'p-limit'

export interface Env {
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  UPTIME_WORKER_D1: D1Database
  ASSETS: Fetcher // Workers Static Assets
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
  VPS1_IP?: string
  VPS1_PORT?: string
  HOMELAB_HOST?: string
  HOMELAB_PORT?: string
}

export default {
  // ── HTTP 请求处理（API + 静态资源）──
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return withSecurityHeaders(new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }))
    }

    if (!isBasicAuthValid(request.headers.get('Authorization'), workerConfig.passwordProtection)) {
      return withSecurityHeaders(new Response(JSON.stringify({ code: 401, message: 'Not authenticated' }), {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic', 'Content-Type': 'application/json' },
      }))
    }

    if (url.pathname === '/api/data') {
      return withSecurityHeaders(await handleDataAPI(env, ctx))
    }
    if (url.pathname === '/api/badge') {
      return withSecurityHeaders(await handleBadgeAPI(request, env))
    }
    if (url.pathname === '/api/health') {
      return withSecurityHeaders(await handleHealthAPI(env))
    }

    // 非 API 路径 → Workers Static Assets（SPA）
    // 如果 assets 找不到匹配文件（SPA 前端路由 fallback），返回 index.html
    const asset = await env.ASSETS.fetch(request)
    if (asset.status === 404) {
      // SPA 回退：让前端 hash routing 处理
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request)))
    }
    return withSecurityHeaders(asset)
  },

  // ── 定时任务（每分钟跑一次监控）──
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const envWithDefaults = { ...env, VPS1_PORT: env.VPS1_PORT || '22' } as Env & Record<string, unknown>
    const config = validateAndResolveConfig(workerConfig, envWithDefaults)
    const workerLocation = (await getWorkerLocation()) || 'ERROR'
    console.log(`Running scheduled event on ${workerLocation}...`)

    // Create a wrapped MonitorState from stored compacted state
    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    state.data.overallDown = 0
    state.data.overallUp = 0

    let statusChanged = false
    const currentTimeSecond = Math.round(Date.now() / 1000)

    // Parallel check multiple monitors
    // Max concurrent connection is 6 limited by Cloudflare Workers, we use 5 here to be safe
    type CheckResult = { id: string; location: string; status: ProbeStatus }
    let checkQueue: Promise<CheckResult>[] = []
    let checkResult: Record<string, CheckResult> = {};
    const limit = pLimit(5);
    for (const monitor of config.monitors) {
      checkQueue.push(limit(() => doMonitor(monitor, workerLocation, env)))
    }
    for (const result of await Promise.all(checkQueue)) {
      checkResult[result.id] = result
    }

    // Update each monitor's state based on check results
    for (const monitor of config.monitors) {
      try {
      logEvent('monitor_result_processing', { monitorId: monitor.id })

      let monitorStatusChanged = false
      const { location: checkLocation, status } = checkResult[monitor.id]

      // Update counters
      status.up ? state.data.overallUp++ : state.data.overallDown++

      // Update incidents
      // Create a dummy incident to store the start time of the monitoring and simplify logic
      if (state.incidentLen(monitor.id) === 0) {
        state.appendIncident(monitor.id, {
          start: [currentTimeSecond],
          end: currentTimeSecond,
          error: ['dummy'],
        })
      }

      // Then lastIncident here must not be null
      let lastIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)

      if (status.up) {
        // Current status is up
        // close existing incident if any
        if (lastIncident.end === null) {
          lastIncident.end = currentTimeSecond
          // write back the modified last incident
          state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)

          monitorStatusChanged = true
          try {
            if (
              // grace period not set OR ...
              config.notification?.gracePeriod === undefined ||
              // only when we have sent a notification for DOWN status, we will send a notification for UP status (within 30 seconds of possible drift)
              currentTimeSecond - lastIncident.start[0] >=
                (config.notification.gracePeriod + 1) * 60 - 30
            ) {
              await formatAndNotify(env, config, monitor, true, lastIncident.start[0], currentTimeSecond, 'OK')
            } else {
              logEvent('notification_skipped', { monitorId: monitor.id, reason: 'grace_period' })
            }

            console.log('Calling config onStatusChange callback...')
            await config.callbacks?.onStatusChange?.(
              env,
              monitor,
              true,
              lastIncident.start[0],
              currentTimeSecond,
              'OK'
            )
          } catch {
            logEvent('callback_failed', { type: 'on_status_change' })
          }
        }
      } else {
        // Current status is down
        // open new incident if not already open
        if (lastIncident.end !== null) {
          state.appendIncident(monitor.id, {
            start: [currentTimeSecond],
            end: null,
            error: [status.internalError],
          })
          monitorStatusChanged = true
        } else if (lastIncident.end === null && lastIncident.error.slice(-1)[0] !== status.internalError) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.internalError)

          // write back the modified last incident
          state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)
          monitorStatusChanged = true
        }

        const currentIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)
        try {
          if (
            // monitor status changed AND...
            (monitorStatusChanged &&
              // grace period not set OR ...
              (config.notification?.gracePeriod === undefined ||
                // have sent a notification for DOWN status
                currentTimeSecond - currentIncident.start[0] >=
                  (config.notification.gracePeriod + 1) * 60 - 30)) ||
            // grace period is set AND...
            (config.notification?.gracePeriod !== undefined &&
              // grace period is met
              currentTimeSecond - currentIncident.start[0] >=
                config.notification.gracePeriod * 60 - 30 &&
              currentTimeSecond - currentIncident.start[0] <
                config.notification.gracePeriod * 60 + 30)
          ) {
            if (
              currentIncident.start[0] !== currentTimeSecond &&
              config.notification?.skipErrorChangeNotification
            ) {
              console.log(
                'Skipping notification for following error reason change due to user config'
              )
            } else {
              await formatAndNotify(
                env,
                config,
                monitor,
                false,
                currentIncident.start[0],
                currentTimeSecond,
                status.publicMessage
              )
            }
          } else {
            logEvent('notification_skipped', { monitorId: monitor.id, reason: 'grace_period' })
          }

          if (monitorStatusChanged) {
            console.log('Calling config onStatusChange callback...')
            await config.callbacks?.onStatusChange?.(
              env,
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.publicMessage
            )
          }
        } catch {
          logEvent('callback_failed', { type: 'on_status_change' })
        }

        try {
          console.log('Calling config onIncident callback...')
          await config.callbacks?.onIncident?.(
            env,
            monitor,
            currentIncident.start[0],
            currentTimeSecond,
            status.publicMessage
          )
        } catch {
          logEvent('callback_failed', { type: 'on_incident' })
        }
      }

      // append to latency data
      state.appendLatency(monitor.id, {
        loc: checkLocation,
        ping: status.ping,
        time: currentTimeSecond,
      })

      // discard old data
      while (state.getFirstLatency(monitor.id).time < currentTimeSecond - 12 * 60 * 60) {
        state.unshiftLatency(monitor.id)
      }

      // discard old incidents
      while (
        state.incidentLen(monitor.id) > 0 &&
        state.getIncident(monitor.id, 0).end &&
        state.getIncident(monitor.id, 0).end! < currentTimeSecond - 90 * 24 * 60 * 60
      ) {
        state.shiftIncident(monitor.id)
      }

      if (
        state.incidentLen(monitor.id) === 0 ||
        (state.getIncident(monitor.id, 0).start[0] > currentTimeSecond - 90 * 24 * 60 * 60 &&
          state.getIncident(monitor.id, 0).error[0] != 'dummy')
      ) {
        // put the dummy incident back
        state.unshiftIncident(monitor.id, {
          start: [currentTimeSecond - 90 * 24 * 60 * 60],
          end: currentTimeSecond - 90 * 24 * 60 * 60,
          error: ['dummy'],
        })
      }

      statusChanged ||= monitorStatusChanged
      } catch {
        logEvent('monitor_processing_failed', { monitorId: monitor.id })
        continue
      }
    }

    console.log(
      `statusChanged: ${statusChanged}, lastUpdate: ${state.data.lastUpdate}, currentTime: ${currentTimeSecond}`
    )
    // Update state
    // Allow for a cooldown period before writing to storage
    if (
      statusChanged ||
      currentTimeSecond - state.data.lastUpdate >=
        (config.kvWriteCooldownMinutes ?? 3) * 60 - 10 // Allow for 10 seconds of clock drift
    ) {
      console.log('Updating state...')
      state.data.lastUpdate = currentTimeSecond
      await setToStore(env, 'state', state.getCompactedStateStr())
    } else {
      console.log('Skipping state update due to cooldown period.')
    }
  },
}

export class RemoteChecker extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async getLocationAndStatus(
    monitor: MonitorTarget
  ): Promise<{ location: string; status: ProbeStatus }> {
    const colo = await getWorkerLocation()
    logEvent('remote_checker_started', { monitorId: monitor.id, location: colo })
    const status = await getStatus(monitor)
    return {
      location: colo,
      status: status,
    }
  }
}

// ── API handlers ──────────────────────────────────────────

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function handleDataAPI(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default
  const cacheKey = new Request('https://uptime-worker-internal/api/data?schemaVersion=2', { method: 'GET' })

  const cached = await cache.match(cacheKey)
  if (cached) return cached

  const compactedState = new CompactedMonitorStateWrapper(
    await getFromStore(env, 'state')
  )

  // Uncompact full state for SPA to render 90-day bars & latency chart.
  const fullState = compactedState.uncompact()
  const payload = {
    ...buildDataPayload(fullState, workerConfig.monitors, pageConfig || {}, Math.round(Date.now() / 1000)),
    maintenances,
  }
  const cacheControl = payload.stale ? 'no-store' : 's-maxage=30'

  const response = new Response(
    JSON.stringify(payload),
    { headers: { ...jsonHeaders, 'Cache-Control': cacheControl } }
  )

  if (!payload.stale) ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
