import { DurableObject } from 'cloudflare:workers'
import { MonitorTarget } from '../types/config'
import { workerConfig } from '../uptime.config'
import { doMonitor, getStatus } from './monitor'
import { formatAndNotify, getWorkerLocation } from './util'
import { CompactedMonitorStateWrapper, getFromStore, setToStore } from './store'
import pLimit from 'p-limit'

export interface Env {
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  UPTIME_WORKER_D1: D1Database
  ASSETS: Fetcher // Workers Static Assets
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
  VPS1_IP?: string
  VPS1_PORT?: string
}

export default {
  // ── HTTP 请求处理（API + 静态资源）──
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    // API 路由
    if (url.pathname === '/api/data') {
      return handleDataAPI(env)
    }
    if (url.pathname === '/api/badge') {
      return handleBadgeAPI(request, env)
    }

    // Basic Auth 保护（可选）：从配置读密码
    const passwordProtection = workerConfig.passwordProtection
    if (passwordProtection) {
      const authHeader = request.headers.get('Authorization')
      const expected = 'Basic ' + btoa(passwordProtection)
      let authenticated = false
      if (authHeader && authHeader.length === expected.length) {
        authenticated = true
        for (let i = 0; i < authHeader.length; i++) {
          if (authHeader[i] !== expected[i]) authenticated = false
        }
      }
      if (!authenticated) {
        return new Response(
          JSON.stringify({ code: 401, message: 'Not authenticated' }),
          { status: 401, headers: { 'WWW-Authenticate': 'Basic', 'Content-Type': 'application/json' } }
        )
      }
    }

    // 非 API 路径 → Workers Static Assets（SPA）
    // 如果 assets 找不到匹配文件（SPA 前端路由 fallback），返回 index.html
    const asset = await env.ASSETS.fetch(request)
    if (asset.status === 404) {
      // SPA 回退：让前端 hash routing 处理
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request))
    }
    return asset
  },

  // ── 定时任务（每分钟跑一次监控）──
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
    type CheckResult = { id: string; location: string; status: { ping: number; up: boolean; err: string } }
    let checkQueue: Promise<CheckResult>[] = []
    let checkResult: Record<string, CheckResult> = {};
    const limit = pLimit(5);
    for (let monitor of workerConfig.monitors) {
      // Inject env variables into monitor target
      if (monitor.target.includes('<VPS1_IP>') && env.VPS1_IP) {
        monitor = { ...monitor, target: monitor.target.replace('<VPS1_IP>', env.VPS1_IP) }
      }
      if (monitor.target.includes('<VPS1_PORT>') && env.VPS1_PORT) {
        monitor = { ...monitor, target: monitor.target.replace('<VPS1_PORT>', env.VPS1_PORT) }
      } else if (monitor.target.includes('<VPS1_PORT>')) {
        monitor = { ...monitor, target: monitor.target.replace('<VPS1_PORT>', '22') } // default to 22
      }

      checkQueue.push(limit(() => doMonitor(monitor, workerLocation, env)))
    }
    for (const result of await Promise.all(checkQueue)) {
      checkResult[result.id] = result
    }

    // Update each monitor's state based on check results
    for (const monitor of workerConfig.monitors) {
      console.log(`Processing monitor result: ${monitor.name} (${monitor.id})`)

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
              workerConfig.notification?.gracePeriod === undefined ||
              // only when we have sent a notification for DOWN status, we will send a notification for UP status (within 30 seconds of possible drift)
              currentTimeSecond - lastIncident.start[0] >=
                (workerConfig.notification.gracePeriod + 1) * 60 - 30
            ) {
              await formatAndNotify(env, monitor, true, lastIncident.start[0], currentTimeSecond, 'OK')
            } else {
              console.log(
                `grace period (${workerConfig.notification?.gracePeriod}m) not met, skipping webhook UP notification for ${monitor.name}`
              )
            }

            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks?.onStatusChange?.(
              env,
              monitor,
              true,
              lastIncident.start[0],
              currentTimeSecond,
              'OK'
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        }
      } else {
        // Current status is down
        // open new incident if not already open
        if (lastIncident.end !== null) {
          state.appendIncident(monitor.id, {
            start: [currentTimeSecond],
            end: null,
            error: [status.err],
          })
          monitorStatusChanged = true
        } else if (lastIncident.end === null && lastIncident.error.slice(-1)[0] !== status.err) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.err)

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
              (workerConfig.notification?.gracePeriod === undefined ||
                // have sent a notification for DOWN status
                currentTimeSecond - currentIncident.start[0] >=
                  (workerConfig.notification.gracePeriod + 1) * 60 - 30)) ||
            // grace period is set AND...
            (workerConfig.notification?.gracePeriod !== undefined &&
              // grace period is met
              currentTimeSecond - currentIncident.start[0] >=
                workerConfig.notification.gracePeriod * 60 - 30 &&
              currentTimeSecond - currentIncident.start[0] <
                workerConfig.notification.gracePeriod * 60 + 30)
          ) {
            if (
              currentIncident.start[0] !== currentTimeSecond &&
              workerConfig.notification?.skipErrorChangeNotification
            ) {
              console.log(
                'Skipping notification for following error reason change due to user config'
              )
            } else {
              await formatAndNotify(
                env,
                monitor,
                false,
                currentIncident.start[0],
                currentTimeSecond,
                status.err
              )
            }
          } else {
            console.log(
              `Grace period (${workerConfig.notification
                ?.gracePeriod}m) not met or no change (currently down for ${
                currentTimeSecond - currentIncident.start[0]
              }s, changed ${monitorStatusChanged}), skipping webhook DOWN notification for ${
                monitor.name
              }`
            )
          }

          if (monitorStatusChanged) {
            console.log('Calling config onStatusChange callback...')
            await workerConfig.callbacks?.onStatusChange?.(
              env,
              monitor,
              false,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          }
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
        }

        try {
          console.log('Calling config onIncident callback...')
          await workerConfig.callbacks?.onIncident?.(
            env,
            monitor,
            currentIncident.start[0],
            currentTimeSecond,
            status.err
          )
        } catch (e) {
          console.log('Error calling callback: ')
          console.log(e)
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
    }

    console.log(
      `statusChanged: ${statusChanged}, lastUpdate: ${state.data.lastUpdate}, currentTime: ${currentTimeSecond}`
    )
    // Update state
    // Allow for a cooldown period before writing to storage
    if (
      statusChanged ||
      currentTimeSecond - state.data.lastUpdate >=
        (workerConfig.kvWriteCooldownMinutes ?? 3) * 60 - 10 // Allow for 10 seconds of clock drift
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
  ): Promise<{ location: string; status: { ping: number; up: boolean; err: string } }> {
    const colo = (await getWorkerLocation()) as string
    console.log(`Running remote checker (DurableObject) at ${colo}...`)
    const status = await getStatus(monitor)
    return {
      location: colo,
      status: status,
    }
  }

  async kill() {
    // Throwing an error in `blockConcurrencyWhile` will terminate the Durable Object instance
    // https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
    this.ctx.blockConcurrencyWhile(async () => {
      throw 'killed'
    })
  }
}

// ── API handlers ──────────────────────────────────────────

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function handleDataAPI(env: Env): Promise<Response> {
  const { maintenances, pageConfig, workerConfig } = await import('../uptime.config')
  const compactedState = new CompactedMonitorStateWrapper(
    await getFromStore(env, 'state')
  )

  if (compactedState.data.lastUpdate === 0) {
    return new Response(JSON.stringify({ error: 'No data available' }), {
      status: 500,
      headers: jsonHeaders,
    })
  }

  // Uncompact full state for SPA to render 90-day bars & latency chart
  const fullState = compactedState.uncompact()

  // Build summary monitors for quick access
  let monitors: any = {}
  for (let monitor of workerConfig.monitors) {
    const lastIncident = compactedState.getIncident(
      monitor.id,
      compactedState.incidentLen(monitor.id) - 1
    )
    const isUp = lastIncident?.end !== null
    const latency = compactedState.getLastLatency(monitor.id)
    monitors[monitor.id] = {
      up: isUp,
      latency: latency.ping,
      location: latency.loc,
      message: isUp ? 'OK' : lastIncident?.error[lastIncident.error.length - 1],
    }
  }

  // Strip monitors of sensitive fields for client
  const safeMonitors = workerConfig.monitors.map(m => ({
    id: m.id,
    name: m.name,
    tooltip: m.tooltip,
    statusPageLink: m.statusPageLink,
    hideLatencyChart: m.hideLatencyChart,
  }))

  return new Response(
    JSON.stringify({
      up: compactedState.data.overallUp,
      down: compactedState.data.overallDown,
      updatedAt: compactedState.data.lastUpdate,
      monitors,
      maintenances,
      config: {
        title: pageConfig?.title || 'UptimeWorker',
        links: pageConfig?.links || [],
        group: pageConfig?.group,
        logo: pageConfig?.logo,
        favicon: pageConfig?.favicon,
        customFooter: pageConfig?.customFooter,
        maintenances: pageConfig?.maintenances,
      },
      monitorsConfig: safeMonitors,
      // Full state for SPA rendering (incidents + latency time series)
      state: {
        incident: fullState.incident,
        latency: fullState.latency,
      },
    }),
    { headers: jsonHeaders }
  )
}

type BadgePayload = {
  schemaVersion: 1
  label: string
  message: string
  color: string
  isError?: boolean
}

function errorBadge(label: string, message: string): BadgePayload {
  return { schemaVersion: 1, label, message, color: 'lightgrey', isError: true }
}

async function handleBadgeAPI(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  const monitorId = url.searchParams.get('id')
  const label = url.searchParams.get('label') ?? monitorId ?? 'UptimeWorker'
  const upMsg = url.searchParams.get('up') ?? 'UP'
  const downMsg = url.searchParams.get('down') ?? 'DOWN'
  const colorUp = url.searchParams.get('colorUp') ?? 'brightgreen'
  const colorDown = url.searchParams.get('colorDown') ?? 'red'

  if (!monitorId) {
    return new Response(JSON.stringify(errorBadge(label, 'no-monitor')), {
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
      status: 400,
    })
  }

  const compactedState = new CompactedMonitorStateWrapper(
    await getFromStore(env, 'state')
  )

  const lastIncident = compactedState.getIncident(monitorId, compactedState.incidentLen(monitorId) - 1)
  const isUp = lastIncident?.end !== null

  const badge: BadgePayload = {
    schemaVersion: 1,
    label,
    message: isUp ? upMsg : downMsg,
    color: isUp ? colorUp : colorDown,
  }

  return new Response(JSON.stringify(badge), {
    headers: { ...jsonHeaders, 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
