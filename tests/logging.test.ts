import { afterEach, describe, expect, it, vi } from 'vitest'
import { webhookNotify } from '../src/util'

describe('webhook logging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('never logs webhook credentials or body', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    const env = {} as Parameters<typeof webhookNotify>[0]
    const webhook = {
      url: 'https://api.telegram.org/bot-token/sendMessage?chat_id=chat-id',
      headers: { Authorization: 'Bearer bot-token' },
      payloadType: 'json' as const,
      payload: { text: '$MSG', chat_id: 'chat-id' },
    }

    await expect(webhookNotify(env, webhook, 'private message')).resolves.toBeUndefined()

    const output = logSpy.mock.calls.flat().join(' ')
    expect(output).toContain('host="api.telegram.org"')
    expect(output).not.toMatch(/bot-token|chat-id|private message|Authorization/i)
  })
})
