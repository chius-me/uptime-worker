import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

type Monitor = {
  id: string
  name: string
  statusPageLink?: string
  tooltip?: string
  hideLatencyChart?: boolean
}

type Renderers = {
  statusIcon: (status: string) => string
  renderMonitor: (monitor: Monitor, monitorData: { up: boolean } | undefined, state: unknown) => string
}

async function loadRenderers(): Promise<Renderers> {
  const app = await readFile(new URL('../static/js/app.js', import.meta.url), 'utf8')
  const window = { addEventListener() {}, UW: {} }
  const document = {
    addEventListener() {},
    documentElement: { setAttribute() {} },
    getElementById() { return null },
    querySelector() { return null },
  }
  const localStorage = { getItem() { return null }, setItem() {} }
  const I18N = { init: async () => {}, t: (text: string) => text }

  return new Function('window', 'document', 'localStorage', 'I18N', `${app}\nreturn { statusIcon, renderMonitor }`)(
    window,
    document,
    localStorage,
    I18N,
  ) as Renderers
}

describe('monitor status icon markup', () => {
  it('renders status, name ordering, links, and service tooltips', async () => {
    const { statusIcon, renderMonitor } = await loadRenderers()

    expect(statusIcon('up')).toContain('class="monitor-status-icon up"')
    expect(statusIcon('down')).toContain('class="monitor-status-icon down"')
    expect(statusIcon('unknown')).toContain('class="monitor-status-icon unknown"')

    const linked = renderMonitor({
      id: 'api',
      name: 'Public API',
      statusPageLink: 'https://status.example.test/api',
      tooltip: 'Production API service',
      hideLatencyChart: true,
    }, { up: true }, {})
    expect(linked).toContain('<a href="https://status.example.test/api"')
    expect(linked.indexOf('monitor-status-icon up')).toBeLessThan(linked.indexOf('Public API'))
    expect(linked).toContain('title="Production API service"')

    const unlinked = renderMonitor({ id: 'worker', name: 'Worker', hideLatencyChart: true }, { up: false }, {})
    expect(unlinked).not.toContain('<a href=')
    expect(unlinked.indexOf('monitor-status-icon down')).toBeLessThan(unlinked.indexOf('Worker'))

    const unknown = renderMonitor({ id: 'cache', name: 'Cache' }, undefined, {})
    expect(unknown.indexOf('monitor-status-icon unknown')).toBeLessThan(unknown.indexOf('Cache'))
  })
})
