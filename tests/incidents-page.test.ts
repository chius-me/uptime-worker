import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

type IncidentView = {
  id: string
  monitorId: string
  monitorName: string
  startedAt: number
  resolvedAt: number | null
  ongoing: boolean
  durationSeconds: number
  publicMessage: string
}

const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process

type IncidentRenderers = {
  startOfLocalDaySeconds?: (date: Date) => number
  localDayWindowSeconds?: (date: Date) => { start: number; end: number }
  buildIncidentTimeline?: (state: unknown, monitors: Array<{ id: string; name: string }>, nowSeconds?: number) => IncidentView[]
  renderIncident?: (incident: IncidentView) => string
}

async function loadIncidentRenderers(t: (text: string) => string = (text) => text): Promise<IncidentRenderers> {
  const app = await readFile(fileURLToPath(String(new URL('../static/js/app.js', import.meta.url))), 'utf8')
  const window = { addEventListener() {}, location: { hash: '' }, UW: {} }
  const document = {
    addEventListener() {},
    documentElement: { setAttribute() {} },
    getElementById() { return null },
    querySelector() { return null },
  }
  const localStorage = { getItem() { return null }, setItem() {} }
  const I18N = { init: async () => {}, t }

  return new Function('window', 'document', 'localStorage', 'I18N', `${app}\nreturn {
    startOfLocalDaySeconds: typeof startOfLocalDaySeconds === 'function' ? startOfLocalDaySeconds : undefined,
    localDayWindowSeconds: typeof localDayWindowSeconds === 'function' ? localDayWindowSeconds : undefined,
    buildIncidentTimeline: typeof buildIncidentTimeline === 'function' ? buildIncidentTimeline : undefined,
    renderIncident: typeof renderIncident === 'function' ? renderIncident : undefined,
  }`)(window, document, localStorage, I18N) as IncidentRenderers
}

describe('incident history', () => {
  it('provides localized fixed public incident categories in every supported locale', async () => {
    const localeFiles = ['en', 'zh-CN', 'zh-TW', 'de-DE', 'fr-FR']
    const categories = [
      'Not checked yet',
      'OK',
      'Timeout',
      'Unexpected status code',
      'TLS validation failed',
      'Content check failed',
      'Content check inconclusive',
      'Connection failed',
    ]

    await Promise.all(localeFiles.map(async (locale) => {
      const content = await readFile(fileURLToPath(String(new URL(`../static/locales/${locale}/common.json`, import.meta.url))), 'utf8')
      const translations = JSON.parse(content) as Record<string, string>
      categories.forEach((category) => expect(translations[category]).toBeTypeOf('string'))
    }))
  })

  it('uses local midnight for status-day boundaries', async () => {
    const { startOfLocalDaySeconds } = await loadIncidentRenderers()

    expect(startOfLocalDaySeconds).toBeTypeOf('function')
    expect(startOfLocalDaySeconds!(new Date(2026, 6, 22, 12))).toBe(
      new Date(2026, 6, 22, 0, 0, 0, 0).getTime() / 1000,
    )
  })

  it('uses the adjacent local midnight as the DST-safe day end', async () => {
    const { localDayWindowSeconds } = await loadIncidentRenderers()
    const originalTimeZone = nodeProcess.env.TZ
    nodeProcess.env.TZ = 'America/Los_Angeles'

    try {
      const window = localDayWindowSeconds?.(new Date(2026, 2, 8, 12))

      expect(localDayWindowSeconds).toBeTypeOf('function')
      expect(window).toEqual({
        start: new Date(2026, 2, 8, 0, 0, 0, 0).getTime() / 1000,
        end: new Date(2026, 2, 9, 0, 0, 0, 0).getTime() / 1000,
      })
      expect(window!.end - window!.start).toBe(23 * 60 * 60)
    } finally {
      if (originalTimeZone === undefined) delete nodeProcess.env.TZ
      else nodeProcess.env.TZ = originalTimeZone
    }
  })

  it('merges public incidents for configured monitors into a newest-first timeline', async () => {
    const { buildIncidentTimeline } = await loadIncidentRenderers()
    const state = {
      incident: {
        api: [
          {
            id: 'api:100',
            startedAt: 100,
            resolvedAt: 220,
            changes: [{ at: 100, publicMessage: 'Connection failed' }],
            start: [100],
            end: 220,
            error: ['Connection failed'],
          },
          {
            id: 'api:200',
            startedAt: 200,
            resolvedAt: 240,
            changes: [{ at: 200, publicMessage: 'Timeout' }],
          },
        ],
        web: [{
          id: 'web:300',
          startedAt: 300,
          resolvedAt: null,
          changes: [{ at: 300, publicMessage: 'TLS validation failed' }],
        }],
      },
    }

    expect(buildIncidentTimeline).toBeTypeOf('function')
    const timeline = buildIncidentTimeline!(state, [
      { id: 'api', name: 'API' },
      { id: 'web', name: 'Web' },
    ], 500)

    expect(timeline.map(incident => incident.id)).toEqual(['web:300', 'api:200', 'api:100'])
    expect(timeline[2]).toMatchObject({
      monitorId: 'api',
      monitorName: 'API',
      ongoing: false,
      durationSeconds: 120,
      publicMessage: 'Connection failed',
    })
  })

  it('marks unresolved incidents as ongoing and excludes the migrated v1 monitoring dummy', async () => {
    const { buildIncidentTimeline } = await loadIncidentRenderers()
    const state = {
      incident: {
        api: [
          { start: [10], end: 10, error: ['dummy'] },
          {
            id: 'api:400',
            startedAt: 400,
            resolvedAt: null,
            changes: [{ at: 400, publicMessage: 'Request timed out' }],
            start: [400],
            end: null,
            error: ['Request timed out'],
          },
        ],
      },
    }

    expect(buildIncidentTimeline).toBeTypeOf('function')
    expect(buildIncidentTimeline!(state, [{ id: 'api', name: 'API' }], 460)).toEqual([
      expect.objectContaining({ ongoing: true, durationSeconds: 60, publicMessage: 'Request timed out' }),
    ])
  })

  it('localizes only allowlisted categories and keeps fallback incident output escaped', async () => {
    const t = vi.fn((text: string) => text === 'Timeout' ? 'Zeitüberschreitung' : text)
    const { renderIncident } = await loadIncidentRenderers(t)
    const incident = {
      id: 'api:100',
      monitorId: 'api',
      monitorName: 'API',
      startedAt: 100,
      resolvedAt: 110,
      ongoing: false,
      durationSeconds: 10,
      publicMessage: 'Timeout',
    }

    expect(renderIncident).toBeTypeOf('function')
    expect(renderIncident!(incident)).toContain('Zeitüberschreitung')

    const unsafeCategory = '<img src=x onerror=alert(1)>'
    const unsafeHtml = renderIncident!({ ...incident, publicMessage: unsafeCategory })
    expect(unsafeHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(unsafeHtml).not.toContain('<img src=x')
    expect(t).not.toHaveBeenCalledWith(unsafeCategory)
  })
})
