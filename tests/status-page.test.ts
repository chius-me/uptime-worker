import { describe, expect, it } from 'vitest'
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

async function loadRenderers(): Promise<Renderers> {
  const app = await readFile(fileURLToPath(String(new URL('../static/js/app.js', import.meta.url))), 'utf8')
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
})
