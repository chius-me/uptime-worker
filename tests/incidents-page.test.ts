import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

type IncidentView = {
  monitorId: string
  monitorName: string
  startedAt: number
  resolvedAt: number | null
  ongoing: boolean
  durationSeconds: number
  publicMessage: string
}

type IncidentRenderers = {
  startOfLocalDaySeconds?: (date: Date) => number
  buildIncidentTimeline?: (state: unknown, monitors: Array<{ id: string; name: string }>, nowSeconds?: number) => IncidentView[]
}

async function loadIncidentRenderers(): Promise<IncidentRenderers> {
  const app = await readFile(new URL('../static/js/app.js', import.meta.url), 'utf8')
  const window = { addEventListener() {}, location: { hash: '' }, UW: {} }
  const document = {
    addEventListener() {},
    documentElement: { setAttribute() {} },
    getElementById() { return null },
    querySelector() { return null },
  }
  const localStorage = { getItem() { return null }, setItem() {} }
  const I18N = { init: async () => {}, t: (text: string) => text }

  return new Function('window', 'document', 'localStorage', 'I18N', `${app}\nreturn {
    startOfLocalDaySeconds: typeof startOfLocalDaySeconds === 'function' ? startOfLocalDaySeconds : undefined,
    buildIncidentTimeline: typeof buildIncidentTimeline === 'function' ? buildIncidentTimeline : undefined,
  }`)(window, document, localStorage, I18N) as IncidentRenderers
}

describe('incident history', () => {
  it('uses local midnight for status-day boundaries', async () => {
    const { startOfLocalDaySeconds } = await loadIncidentRenderers()

    expect(startOfLocalDaySeconds).toBeTypeOf('function')
    expect(startOfLocalDaySeconds!(new Date(2026, 6, 22, 12))).toBe(
      new Date(2026, 6, 22, 0, 0, 0, 0).getTime() / 1000,
    )
  })

  it('merges public incidents for configured monitors into a newest-first timeline', async () => {
    const { buildIncidentTimeline } = await loadIncidentRenderers()
    const state = {
      incident: {
        api: [{
          id: 'api:100',
          startedAt: 100,
          resolvedAt: 220,
          changes: [{ at: 100, publicMessage: 'Connection failed' }],
          start: [100],
          end: 220,
          error: ['Connection failed'],
        }],
        removed: [{
          id: 'removed:300',
          startedAt: 300,
          resolvedAt: null,
          changes: [{ at: 300, publicMessage: 'Timeout' }],
        }],
      },
    }

    expect(buildIncidentTimeline).toBeTypeOf('function')
    expect(buildIncidentTimeline!(state, [{ id: 'api', name: 'API' }], 500)).toEqual([
      expect.objectContaining({
        monitorId: 'api',
        monitorName: 'API',
        ongoing: false,
        durationSeconds: 120,
        publicMessage: 'Connection failed',
      }),
    ])
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
})
