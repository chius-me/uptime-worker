import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

type Renderers = {
  renderMonitor: (monitor: { id: string; name: string; hideLatencyChart?: boolean }, monitorData: { up: boolean }, state: unknown) => string
  renderStatusPageHtml: (data: Record<string, unknown>) => string
}

async function loadRenderers(): Promise<Renderers> {
  const app = await readFile(fileURLToPath(String(new URL('../static/js/app.js', import.meta.url))), 'utf8')
  const window = { addEventListener() {}, location: { hash: '' }, UW: {} }
  const document = {
    addEventListener() {},
    documentElement: { setAttribute() {} },
    getElementById() { return null },
    querySelector() { return null },
  }
  const localStorage = { getItem() { return null }, setItem() {} }
  const I18N = { init: async () => {}, t: (text: string) => text }

  return new Function('window', 'document', 'localStorage', 'I18N', `${app}\nreturn { renderMonitor, renderStatusPageHtml }`)(
    window,
    document,
    localStorage,
    I18N,
  ) as Renderers
}

describe('accessible status UI', () => {
  it('renders a semantic upcoming-maintenance toggle button', async () => {
    const { renderStatusPageHtml } = await loadRenderers()
    const html = renderStatusPageHtml({
      up: 1,
      down: 0,
      updatedAt: 1_000,
      monitors: {},
      maintenances: [{ start: '2999-01-01T00:00:00Z', title: 'Upgrade', body: 'Brief interruption' }],
      state: {},
      monitorsConfig: [],
      config: {},
    })

    expect(html).toMatch(/<button[^>]*id="upcoming-toggle"[^>]*>/)
  })

  it('provides a labelled canvas and screen-reader chart summary', async () => {
    const { renderMonitor } = await loadRenderers()
    const html = renderMonitor({ id: 'api', name: 'API' }, { up: true }, {
      latency: {
        api: [
          { time: 100, ping: 250 },
          { time: 200, ping: 80 },
          { time: 300, ping: 120 },
        ],
      },
    })

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Response times')
    expect(html).toContain('chart-summary-api')
    expect(html).toContain('Minimum: 80 ms')
    expect(html).toContain('Maximum: 250 ms')
    expect(html).toContain('Latest: 120 ms')
  })

  it('keeps keyboard focus indicators, focusable status bars, and reduced-motion support', async () => {
    const css = await readFile(fileURLToPath(String(new URL('../static/css/style.css', import.meta.url))), 'utf8')
    const app = await readFile(fileURLToPath(String(new URL('../static/js/app.js', import.meta.url))), 'utf8')

    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/s)
    expect(css).toMatch(/\.tooltip:focus-within\s+\.tooltip-text/s)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(app).toContain('tabIndex = 0')
  })
})
