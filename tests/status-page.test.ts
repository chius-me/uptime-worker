// @ts-expect-error jsdom does not publish TypeScript declarations
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

type Monitor = { id: string; name: string; hideLatencyChart?: boolean }
type StatusData = {
  up: number
  down: number
  updatedAt: number
  monitoringStatus: 'initializing' | 'delayed' | 'healthy'
  stale?: boolean
  monitors: Record<string, { up: boolean | null } | undefined>
  maintenances: unknown[]
  state: unknown
  monitorsConfig: Monitor[]
  config: Record<string, unknown>
}

type Renderers = {
  overallStatus: (data: Pick<StatusData, 'up' | 'down' | 'monitoringStatus'>) => { text: string; icon: string; cssClass: string }
  renderMonitor: (monitor: Monitor, monitorData: { up: boolean | null } | undefined, state: unknown) => string
  renderStatusPageHtml: (data: StatusData) => string
}

type UptimeRenderers = {
  drawBars: (monitorId: string, state: unknown, updatedAt: number) => void
  calcAndSetUptime: (monitorId: string, state: unknown, updatedAt: number) => void
}

const appPath = fileURLToPath(String(new URL('../static/js/app.js', import.meta.url)))
const appShell = `<!doctype html><html><body>
  <a class="nav-brand"></a><div id="nav-links"></div><button id="theme-toggle"></button>
  <main id="main-content"></main><div id="footer-text"></div><div id="page-title"></div>
</body></html>`

function translate(text: string, values?: Record<string, unknown>) {
  if (!values) return text
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text === 'Overall' ? 'Overall: {{percent}}%' : text,
  )
}

async function loadRenderers(): Promise<Renderers> {
  const app = await readFile(appPath, 'utf8')
  const window = { addEventListener() {}, UW: {} }
  const document = {
    addEventListener() {},
    documentElement: { setAttribute() {} },
    getElementById() { return null },
    querySelector() { return null },
  }
  const localStorage = { getItem() { return null }, setItem() {} }
  const I18N = { init: async () => {}, t: (text: string, values?: Record<string, unknown>) => values ? `${text} ${JSON.stringify(values)}` : text }

  return new Function('window', 'document', 'localStorage', 'I18N', `${app}\nreturn { overallStatus, renderMonitor, renderStatusPageHtml }`)(
    window,
    document,
    localStorage,
    I18N,
  ) as Renderers
}

async function domReady(dom: JSDOM) {
  if (dom.window.document.readyState !== 'loading') return
  await new Promise<void>((resolve) => {
    dom.window.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  })
}

async function loadDomApp(
  html: string,
  fetchImpl: (...args: unknown[]) => Promise<unknown> = vi.fn(),
): Promise<{ dom: JSDOM; uptime: UptimeRenderers }> {
  const dom = new JSDOM(html, { url: 'https://status.example.test/#/', pretendToBeVisual: true })
  await domReady(dom)
  const app = await readFile(appPath, 'utf8')
  const I18N = { init: async () => {}, t: translate }
  const requestAnimationFrame = (callback: () => void) => { callback(); return 1 }
  const uptime = new Function(
    'window',
    'document',
    'localStorage',
    'I18N',
    'fetch',
    'requestAnimationFrame',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    `${app}\nreturn { drawBars, calcAndSetUptime }`,
  )(
    dom.window,
    dom.window.document,
    dom.window.localStorage,
    I18N,
    fetchImpl,
    requestAnimationFrame,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  ) as UptimeRenderers

  return { dom, uptime }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('status page monitoring state', () => {
  it('provides monitoring-state copy in every supported locale', async () => {
    const localeFiles = ['en', 'zh-CN', 'zh-TW', 'de-DE', 'fr-FR']
    const requiredKeys = ['Monitoring initializing', 'Monitoring delayed', 'Last successful check', 'Unknown']

    await Promise.all(localeFiles.map(async (locale) => {
      const content = await readFile(fileURLToPath(String(new URL(`../static/locales/${locale}/common.json`, import.meta.url))), 'utf8')
      const translations = JSON.parse(content) as Record<string, string>
      requiredKeys.forEach((key) => expect(translations[key]).toBeTypeOf('string'))
    }))
  })

  it('styles delayed monitoring without the healthy green treatment', async () => {
    const css = await readFile(fileURLToPath(String(new URL('../static/css/style.css', import.meta.url))), 'utf8')

    expect(css).toMatch(/\.overall-status\.status-stale\s+\.overall-icon\s*\{[^}]*background:\s*var\(--orange-bg\)/s)
    expect(css).not.toMatch(/\.overall-status\.status-stale\s+\.overall-icon\s*\{[^}]*var\(--green/s)
  })

  it('describes delayed monitoring as stale', async () => {
    const { overallStatus } = await loadRenderers()

    expect(overallStatus({ up: 3, down: 0, monitoringStatus: 'delayed' })).toMatchObject({
      text: 'Monitoring delayed',
      cssClass: 'status-stale',
    })
  })

  it('uses an unknown monitor icon when a monitor state is unavailable', async () => {
    const { renderMonitor } = await loadRenderers()

    expect(renderMonitor({ id: 'api', name: 'Public API', hideLatencyChart: true }, { up: null }, {}))
      .toContain('monitor-status-icon unknown')
  })

  it('renders a delayed status banner instead of an operational claim', async () => {
    const { renderStatusPageHtml } = await loadRenderers()
    const stalePayload: StatusData = {
      up: 3,
      down: 0,
      updatedAt: 1_000,
      monitoringStatus: 'delayed',
      stale: true,
      monitors: { api: { up: null } },
      maintenances: [],
      state: {},
      monitorsConfig: [{ id: 'api', name: 'Public API', hideLatencyChart: true }],
      config: {},
    }

    const html = renderStatusPageHtml(stalePayload)
    expect(html).toContain('overall-status status-stale')
    expect(html).toContain('Monitoring delayed')
    expect(html).not.toContain('All systems operational')
  })

  it('renders an unknown group without hiding known status in other groups', async () => {
    vi.useFakeTimers()
    const mixedPayload: StatusData = {
      up: 2,
      down: 0,
      updatedAt: Math.round(Date.now() / 1_000),
      monitoringStatus: 'initializing',
      stale: false,
      monitors: { api: { up: true }, pending: { up: null }, web: { up: true } },
      maintenances: [],
      state: {},
      monitorsConfig: [
        { id: 'api', name: 'API', hideLatencyChart: true },
        { id: 'pending', name: 'Pending', hideLatencyChart: true },
        { id: 'web', name: 'Web', hideLatencyChart: true },
      ],
      config: { group: { Core: ['api', 'pending'], Website: ['web'] } },
    }
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => mixedPayload })
    const { dom } = await loadDomApp(appShell, fetchImpl)

    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
    await vi.advanceTimersByTimeAsync(0)
    const groups = [...dom.window.document.querySelectorAll('details.monitor-card')]

    expect(dom.window.document.querySelector('.status-title')?.textContent).toContain('Monitoring initializing')
    expect(groups[0].querySelector('summary')?.textContent).toContain('Unknown')
    expect(groups[1].querySelector('summary')?.textContent).toContain('1/1 Operational')
    expect(groups[1].querySelector('.monitor-status-icon.up')).not.toBeNull()
    dom.window.close()
  })

  it('does not trust a healthy aggregate when a configured monitor is unknown', async () => {
    const { renderStatusPageHtml } = await loadRenderers()
    const inconsistentPayload: StatusData = {
      up: 2,
      down: 0,
      updatedAt: Math.round(Date.now() / 1_000),
      monitoringStatus: 'healthy',
      stale: false,
      monitors: { api: { up: true }, pending: { up: null } },
      maintenances: [],
      state: {},
      monitorsConfig: [
        { id: 'api', name: 'API', hideLatencyChart: true },
        { id: 'pending', name: 'Pending', hideLatencyChart: true },
      ],
      config: {},
    }

    const html = renderStatusPageHtml(inconsistentPayload)

    expect(html).toContain('overall-status status-warn')
    expect(html).toContain('Monitoring initializing')
    expect(html).not.toContain('All systems operational')
  })

  it('never renders a healthy overall state without a known configured monitor', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    const payload = {
      schemaVersion: 2,
      up: 0,
      down: 0,
      updatedAt: Math.round(Date.now() / 1_000),
      stale: false,
      monitoringStatus: 'healthy',
      monitors: {},
      config: { title: 'Status', links: [] },
      monitorsConfig: [],
      maintenances: [],
      state: { monitoringStartedAt: {}, incident: {}, latency: {} },
    }
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })
    const { dom } = await loadDomApp(appShell, fetchImpl)

    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
    await vi.advanceTimersByTimeAsync(0)

    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-warn')
    expect(dom.window.document.body.textContent).toContain('Monitoring initializing')
    expect(dom.window.document.body.textContent).not.toContain('All systems operational')
    dom.window.close()
  })

  it('renders an empty configured group as unknown instead of green', async () => {
    const { renderStatusPageHtml } = await loadRenderers()
    const html = renderStatusPageHtml({
      up: 1,
      down: 0,
      updatedAt: Math.round(Date.now() / 1_000),
      monitoringStatus: 'healthy',
      stale: false,
      monitors: { api: { up: true } },
      maintenances: [],
      state: {},
      monitorsConfig: [{ id: 'api', name: 'API', hideLatencyChart: true }],
      config: { group: { Empty: ['missing'], Core: ['api'] } },
    })

    expect(html).toContain('<span>Empty</span>')
    expect(html).toContain('color:var(--gray)')
    expect(html).not.toContain('0/0 Operational')
  })

  it('keeps the last good payload but replaces a green claim after 180 seconds of refresh failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const now = Math.round(Date.now() / 1_000)
    const payload = {
      schemaVersion: 2,
      up: 1,
      down: 0,
      updatedAt: now,
      stale: false,
      monitoringStatus: 'healthy',
      monitors: { api: { up: true, latency: 42, location: 'SFO', message: 'OK' } },
      config: { title: 'Status', links: [] },
      monitorsConfig: [{ id: 'api', name: 'Public API', hideLatencyChart: true }],
      maintenances: [],
      state: { monitoringStartedAt: { api: now - 3_600 }, incident: { api: [] }, latency: {} },
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockRejectedValue(new Error('API unavailable'))
    const { dom } = await loadDomApp(appShell, fetchImpl)

    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-ok')
    expect(dom.window.document.body.textContent).toContain('Public API')

    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-stale')
    expect(dom.window.document.body.textContent).toContain('Monitoring delayed')
    expect(dom.window.document.body.textContent).toContain('Public API')
    expect(dom.window.document.body.textContent).not.toContain('All systems operational')
    dom.window.close()
  })

  it('expires stalled refreshes, renders delayed at 180 seconds, and discovers recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const now = Math.round(Date.now() / 1_000)
    const payload = {
      schemaVersion: 2,
      up: 1,
      down: 0,
      updatedAt: now,
      stale: false,
      monitoringStatus: 'healthy',
      monitors: { api: { up: true, latency: 42, location: 'SFO', message: 'OK' } },
      config: { title: 'Status', links: [] },
      monitorsConfig: [{ id: 'api', name: 'Public API', hideLatencyChart: true }],
      maintenances: [],
      state: { monitoringStartedAt: { api: now - 3_600 }, incident: { api: [] }, latency: {} },
    }
    const stalledFetch = (_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockImplementationOnce(stalledFetch)
      .mockImplementationOnce(stalledFetch)
      .mockImplementationOnce(stalledFetch)
      .mockImplementation(async () => ({
        ok: true,
        json: async () => ({ ...payload, updatedAt: Math.round(Date.now() / 1_000) }),
      }))
    const { dom } = await loadDomApp(appShell, fetchImpl)

    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-ok')

    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-stale')
    expect(dom.window.document.body.textContent).toContain('Monitoring delayed')
    expect(dom.window.document.body.textContent).toContain('Public API')

    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetchImpl).toHaveBeenCalledTimes(5)
    expect(dom.window.document.querySelector('.overall-status')?.className).toContain('status-ok')
    expect(dom.window.document.body.textContent).toContain('All systems operational')
    dom.window.close()
  })
})

describe('uptime baseline rendering', () => {
  it('renders 90 bars and 100% uptime for a monitored service with no incidents', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const now = Math.round(Date.now() / 1_000)
    const { dom, uptime } = await loadDomApp('<div id="bars-api"></div><div id="uptime-api"></div>')
    const state = { monitoringStartedAt: { api: now - 2 * 86_400 }, incident: { api: [] } }

    uptime.drawBars('api', state, now)
    uptime.calcAndSetUptime('api', state, now)

    const bars = dom.window.document.querySelectorAll('#bars-api .uptime-bar')
    expect(bars).toHaveLength(90)
    expect(bars[89].textContent).toContain('100.0%')
    expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe('Overall: 100.0%')
    dom.window.close()
  })

  it('uses monitoringStartedAt rather than a late first incident as the uptime denominator', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const now = Math.round(Date.now() / 1_000)
    const { dom, uptime } = await loadDomApp('<div id="uptime-api"></div>')
    const state = {
      monitoringStartedAt: { api: now - 1_000 },
      incident: { api: [{ startedAt: now - 100, resolvedAt: now - 50 }] },
    }

    uptime.calcAndSetUptime('api', state, now)

    expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe('Overall: 95.00%')
    dom.window.close()
  })

  it('caps an old baseline at the retained 90-day history window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const now = Math.round(Date.now() / 1_000)
    const { dom, uptime } = await loadDomApp('<div id="uptime-api"></div>')
    const windowStart = new Date(2026, 6, 22 - 89, 0, 0, 0, 0).getTime() / 1_000
    const state = {
      monitoringStartedAt: { api: now - 200 * 86_400 },
      incident: { api: [{ startedAt: now - 86_400, resolvedAt: now - 43_200 }] },
    }
    const expected = ((now - windowStart - 43_200) / (now - windowStart) * 100).toPrecision(4)

    uptime.calcAndSetUptime('api', state, now)

    expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe(`Overall: ${expected}%`)
    dom.window.close()
  })

  it('uses the 23-hour local day when a bar crosses the spring DST boundary', async () => {
    const originalTimeZone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 9, 12))

    try {
      const { dom, uptime } = await loadDomApp('<div id="bars-api"></div>')
      const observedAt = Math.round(Date.now() / 1_000)
      const baseline = new Date(2026, 2, 8, 0).getTime() / 1_000
      const incidentStart = new Date(2026, 2, 8, 1, 30).getTime() / 1_000
      const incidentEnd = new Date(2026, 2, 8, 3, 30).getTime() / 1_000
      const state = {
        monitoringStartedAt: { api: baseline },
        incident: { api: [{ startedAt: incidentStart, resolvedAt: incidentEnd }] },
      }

      uptime.drawBars('api', state, observedAt)

      const bars = dom.window.document.querySelectorAll('#bars-api .uptime-bar')
      expect(bars[88].textContent).toContain('95.65%')
      dom.window.close()
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimeZone
    }
  })

  it('does not extend uptime before the exact retention cutoff across fall DST', async () => {
    const originalTimeZone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 10, 23, 30))

    try {
      const now = Math.round(Date.now() / 1_000)
      const { dom, uptime } = await loadDomApp('<div id="uptime-api"></div>')
      const localWindowStart = new Date(2026, 10, 10 - 89, 0).getTime() / 1_000
      const retentionStart = now - 90 * 86_400
      const uptimeStart = Math.max(localWindowStart, retentionStart)
      const downtime = 45 * 86_400
      const state = {
        monitoringStartedAt: { api: now - 200 * 86_400 },
        incident: { api: [{ startedAt: now - 60 * 86_400, resolvedAt: now - 15 * 86_400 }] },
      }
      const expected = ((now - uptimeStart - downtime) / (now - uptimeStart) * 100).toPrecision(4)

      uptime.calcAndSetUptime('api', state, now)

      expect(localWindowStart).toBeLessThan(retentionStart)
      expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe(`Overall: ${expected}%`)
      dom.window.close()
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimeZone
    }
  })

  it('does not accrue healthy uptime after a multi-day-old payload endpoint', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const observedAt = Math.round(new Date('2026-07-19T12:00:00.000Z').getTime() / 1_000)
    const baseline = observedAt - 2 * 86_400
    const { dom, uptime } = await loadDomApp('<div id="bars-api"></div><div id="uptime-api"></div>')
    const state = {
      monitoringStartedAt: { api: baseline },
      incident: { api: [{ startedAt: baseline, resolvedAt: baseline + 43_200 }] },
      latency: { api: [{ time: observedAt, ping: 42 }] },
    }

    uptime.drawBars('api', state, observedAt)
    uptime.calcAndSetUptime('api', state, observedAt)

    const bars = dom.window.document.querySelectorAll('#bars-api .uptime-bar')
    expect(bars[89].textContent).toContain('No Data')
    expect(bars[88].textContent).toContain('No Data')
    expect(bars[87].textContent).toContain('No Data')
    expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe('Overall: 75.00%')
    dom.window.close()
  })

  it('does not accrue open-incident downtime after the last observed sample', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    const observedAt = Math.round(new Date('2026-07-19T12:00:00.000Z').getTime() / 1_000)
    const baseline = observedAt - 2 * 86_400
    const payloadUpdatedAt = observedAt + 6 * 3_600
    const { dom, uptime } = await loadDomApp('<div id="bars-api"></div><div id="uptime-api"></div>')
    const state = {
      monitoringStartedAt: { api: baseline },
      incident: { api: [{ startedAt: observedAt - 43_200, resolvedAt: null }] },
      latency: { api: [{ time: observedAt, ping: 42 }] },
    }

    uptime.drawBars('api', state, payloadUpdatedAt)
    uptime.calcAndSetUptime('api', state, payloadUpdatedAt)

    const bars = dom.window.document.querySelectorAll('#bars-api .uptime-bar')
    expect(bars[89].textContent).toContain('No Data')
    expect(bars[88].textContent).toContain('No Data')
    expect(bars[87].textContent).toContain('No Data')
    expect(dom.window.document.getElementById('uptime-api')?.textContent).toBe('Overall: 75.00%')
    dom.window.close()
  })
})
