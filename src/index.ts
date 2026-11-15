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
      return withSecurityHeaders(withoutPublicCaching(await handleDataAPI(env, ctx)))
    }
    if (url.pathname === '/api/badge') {
      return withSecurityHeaders(await handleBadgeAPI(request, env))
    }
    if (url.pathname === '/api/health') {
      return withSecurityHeaders(await handleHealthAPI(env))
    }

    // 非 API 路径 → Workers Static Assets（SPA）
    // 如果 assets 找不到匹配文件（SPA 前端路由 fallback），返回 index.html
    const expectsShell = url.pathname === '/' || url.pathname === '/index.html' ||
      request.headers.get('Sec-Fetch-Mode') === 'navigate'
    const asset = await env.ASSETS.fetch(expectsShell && (request.method === 'GET' || request.method === 'HEAD')
      ? shellRequest(request)
      : request)
    if (asset.status === 404) {
      // SPA 回退：让前端 hash routing 处理
      const fallbackUrl = new URL('/index.html', request.url).href
      const fallback = await env.ASSETS.fetch(request.method === 'GET' || request.method === 'HEAD'
        ? shellRequest(request, fallbackUrl)
        : new Request(fallbackUrl, request))
      return withSecurityHeaders(renderPageShell(fallback))
    }
    return withSecurityHeaders(renderPageShell(asset))
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Roll the stateless coordinator identity when infrastructure bindings change
    // so a warm Durable Object cannot retain an environment from the prior deploy.
    const id = env.SCHEDULER_DO.idFromName('scheduler-v3')
    try {
      await env.SCHEDULER_DO.get(id).run(event.scheduledTime)
    } catch (error) {
      // Keep the log schema allowlisted: the platform error may contain request
      // metadata or binding details that must not be retained.
      logEvent('scheduled_run_failed', { scheduledAt: event.scheduledTime })
      throw error
    }
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

// Keep the short Worker cache separate from the response browsers and CDNs see.
function withoutPublicCaching(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function renderPageShell(asset: Response): Response {
  if (asset.status !== 200 || !asset.headers.get('Content-Type')?.startsWith('text/html')) return asset

  const title = pageConfig.title || 'UptimeWorker'
  const { logo } = pageConfig
  const html = new HTMLRewriter()
    .on('#page-title, #nav-brand-title', { element: (element) => { element.setInnerContent(title) } })
    .on('#nav-brand-logo', { element: (element) => {
      if (logo) element.setAttribute('src', logo)
      else element.remove()
    } })
    .transform(asset)
  html.headers.delete('ETag')
  html.headers.delete('Last-Modified')
  return withoutPublicCaching(html)
}

function shellRequest(request: Request, url = request.url): Request {
  const headers = new Headers(request.headers)
  // The static asset's validators do not include the configured page branding.
  for (const name of ['If-None-Match', 'If-Modified-Since', 'Range']) headers.delete(name)
  return new Request(url, { method: request.method, headers })
}

async function handleDataAPI(env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default
  const monitorIds = workerConfig.monitors.map(({ id }) => id)
  const cacheKeyUrl = new URL('https://uptime-worker-internal/api/data')
  cacheKeyUrl.searchParams.set('schemaVersion', '2')
  cacheKeyUrl.searchParams.set('monitorIds', JSON.stringify(monitorIds))
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' })

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
