import { describe, expect, it, vi } from 'vitest'
import { resolveConfigValue, validateAndResolveConfig } from '../src/config'

describe('runtime configuration resolution', () => {
  it('resolves nested monitor and webhook values', () => {
    const value = { headers: { Authorization: 'Bearer <API_TOKEN>' }, body: '<BODY>' }

    expect(resolveConfigValue(value, { API_TOKEN: 'secret', BODY: 'payload' })).toEqual({
      headers: { Authorization: 'Bearer secret' },
      body: 'payload',
    })
  })

  it('rejects unresolved placeholders with their config path', () => {
    expect(() => resolveConfigValue('<MISSING>', {}, 'monitors[0].target')).toThrow(
      'Unresolved secret MISSING at monitors[0].target'
    )
  })

  it('rejects duplicate monitor ids', () => {
    const config = {
      monitors: [
        { id: 'duplicate', name: 'one', method: 'GET', target: 'https://one.example' },
        { id: 'duplicate', name: 'two', method: 'GET', target: 'https://two.example' },
      ],
    }

    expect(() => validateAndResolveConfig(config, {})).toThrow('Duplicate monitor id: duplicate')
  })

  it('rejects placeholder monitor ids before their secret values can be resolved', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const config = {
      monitors: [{ id: '<API_TOKEN>', name: 'API', method: 'GET', target: 'https://api.example' }],
    }

    expect(() => validateAndResolveConfig(config, { API_TOKEN: 'secret_that_must_not_be_logged' })).toThrow(
      'Invalid monitor id at monitors[0].id'
    )
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it.each(['api/service', 'api id', '', 'a'.repeat(65)])('rejects unsafe monitor id %j', (id) => {
    const config = {
      monitors: [{ id, name: 'API', method: 'GET', target: 'https://api.example' }],
    }

    expect(() => validateAndResolveConfig(config, {})).toThrow('Invalid monitor id at monitors[0].id')
  })

  it('rejects monitor and webhook timeouts outside 1 through 30000ms', () => {
    const monitorConfig = {
      monitors: [{ id: 'api', name: 'API', method: 'GET', target: 'https://api.example', timeout: 0 }],
    }
    const webhookConfig = {
      monitors: [],
      notification: { webhook: { url: 'https://hooks.example', payloadType: 'json' as const, payload: {}, timeout: 30001 } },
    }

    expect(() => validateAndResolveConfig(monitorConfig, {})).toThrow('Invalid timeout at monitors[0].timeout')
    expect(() => validateAndResolveConfig(webhookConfig, {})).toThrow('Invalid timeout at notification.webhook.timeout')
  })

  it('rejects unsupported proxy protocols and non-HTTPS webhook URLs', () => {
    const proxyConfig = {
      monitors: [{ id: 'api', name: 'API', method: 'GET', target: 'https://api.example', checkProxy: 'ftp://proxy.example' }],
    }
    const webhookConfig = {
      monitors: [],
      notification: { webhook: { url: 'http://hooks.example', payloadType: 'json' as const, payload: {} } },
    }

    expect(() => validateAndResolveConfig(proxyConfig, {})).toThrow('Invalid proxy URL at monitors[0].checkProxy')
    expect(() => validateAndResolveConfig(webhookConfig, {})).toThrow('Webhook URL must use HTTPS at notification.webhook.url')
  })

  it('rejects an empty webhook array', () => {
    expect(() => validateAndResolveConfig({
      monitors: [],
      notification: { webhook: [] },
    }, {})).toThrow('Webhook array must not be empty at notification.webhook')
  })
})
