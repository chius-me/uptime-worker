import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

type SeenRequest = { url: string; headers: Record<string, string>; method: string }
let runtime: Miniflare
let requests: SeenRequest[] = []
let redirect: string | null = null
let redirectStatus = 302

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { getStatus } from './src/monitor';
        import { webhookNotify } from './src/util';
        export default { async fetch(request) {
          const input = await request.json();
          if (input.webhook) {
            try { await webhookNotify({}, {url: input.target, headers: input.headers, payloadType: 'json', payload: {text: '$MSG'}}, 'dummy'); return new Response('delivered'); }
            catch { return new Response('rejected'); }
          }
          return Response.json(await getStatus({id: 'audit', name: 'audit', method: 'GET', timeout: 1000, ...input}));
        }};
      `,
      resolveDir: process.cwd(), sourcefile: 'audit-runtime-worker.ts',
    },
    bundle: true, format: 'esm', platform: 'browser', write: false,
    external: ['cloudflare:sockets', 'cloudflare:workers'],
  })
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-22',
    outboundService: async (request) => {
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers), method: request.method })
      if (redirect && new URL(request.url).pathname !== '/final') {
        return new Response(null, { status: redirectStatus, headers: { location: redirect } })
      }
      return new Response('OK')
    },
  }))
}, 30_000)
afterAll(async () => { await runtime?.dispose() })
beforeEach(() => { requests = []; redirect = null; redirectStatus = 302 })

async function probe(input: Record<string, unknown>) {
  const response = await runtime.dispatchFetch('https://worker.example', { method: 'POST', body: JSON.stringify(input) })
  return response.json() as Promise<{ up: boolean; publicMessage: string }>
}

describe('redirect policy in the Workers runtime', () => {
  it.each(['Cookie', 'X-Api-Key', 'Authorization', 'X-Custom-Credential'])('does not forward %s across origins', async (name) => {
    redirect = 'https://sink.example/final'
    const result = await probe({ target: 'https://origin.example/start', headers: { [name]: 'audit-dummy' } })
    expect(result.up).toBe(false)
    expect(requests.map(({ url }) => url)).toEqual(['https://origin.example/start'])
  })
  it('follows same-origin redirects with the configured credentials', async () => {
    redirect = '/final'
    expect((await probe({ target: 'https://origin.example/start', headers: { Cookie: 'audit=dummy' } })).up).toBe(true)
    expect(requests[1].headers.cookie).toBe('audit=dummy')
  })
  it('allows public HTTP-to-HTTPS redirects', async () => {
    redirect = 'https://other.example/final'
    expect((await probe({ target: 'http://origin.example/start' })).up).toBe(true)
    expect(requests.map(({ url }) => url)).toEqual(['http://origin.example/start', 'https://other.example/final'])
  })
  it('rejects HTTPS downgrades without sending the next request', async () => {
    redirect = 'http://origin.example/final'
    expect((await probe({ target: 'https://origin.example/start' })).up).toBe(false)
    expect(requests).toHaveLength(1)
  })
  it('does not replay a private POST body on a cross-origin 307', async () => {
    redirect = 'https://sink.example/final'
    redirectStatus = 307
    expect((await probe({ target: 'https://origin.example/start', method: 'POST', body: 'audit-private' })).up).toBe(false)
    expect(requests).toHaveLength(1)
  })
  it('bounds redirect loops', async () => {
    redirect = '/start'
    expect((await probe({ target: 'https://origin.example/start' })).up).toBe(false)
    expect(requests).toHaveLength(6)
  })
  it('rejects webhook redirects without forwarding the payload or headers', async () => {
    redirect = 'https://sink.example/final'
    redirectStatus = 307
    const response = await runtime.dispatchFetch('https://worker.example', {
      method: 'POST', body: JSON.stringify({ webhook: true, target: 'https://origin.example/start', headers: { 'X-Api-Key': 'audit-dummy' } }),
    })
    expect(await response.text()).toBe('rejected')
    expect(requests).toHaveLength(1)
  })
  it('still delivers successful webhook requests', async () => {
    const response = await runtime.dispatchFetch('https://worker.example', {
      method: 'POST', body: JSON.stringify({ webhook: true, target: 'https://origin.example/start' }),
    })
    expect(await response.text()).toBe('delivered')
    expect(requests).toHaveLength(1)
  })
})
