import { DurableObject } from 'cloudflare:workers'
import { MonitorTarget } from '../types/config'
import { workerConfig, maintenances, pageConfig } from '../uptime.config'
import { getStatus } from './monitor'
import { getWorkerLocation } from './util'
import { logEvent } from './log'
import { CompactedMonitorStateWrapper, CorruptStateError, getFromStore } from './store'
import { isBasicAuthValid } from './auth'
import { buildDataPayload, handleBadgeAPI, handleHealthAPI, stateUnavailableResponse } from './api'
import { withSecurityHeaders } from './security'
import type { ProbeStatus } from './probe'
import { Scheduler } from './scheduler'
import { resolvePasswordProtection } from './config'

export interface Env {
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  SCHEDULER_DO: DurableObjectNamespace<Scheduler>
  UPTIME_WORKER_D1: D1Database
  ASSETS: Fetcher // Workers Static Assets
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
  VPS1_IP?: string
  VPS1_PORT?: string
  HOMELAB_HOST?: string
  HOMELAB_PORT?: string
  HEARTBEAT_URL?: string
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

    const passwordProtection = resolvePasswordProtection(
      workerConfig.passwordProtection,
      env as unknown as Record<string, unknown>
    )
    if (!isBasicAuthValid(request.headers.get('Authorization'), passwordProtection)) {
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

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const id = env.SCHEDULER_DO.idFromName('singleton')
    await env.SCHEDULER_DO.get(id).run(event.scheduledTime)
  },
}

export { Scheduler }

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

  let compactedState: CompactedMonitorStateWrapper
  try {
    compactedState = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
  } catch (error) {
    if (error instanceof CorruptStateError) return stateUnavailableResponse()
    throw error
  }

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
