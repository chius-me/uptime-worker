import { describe, expect, it } from 'vitest'
import { isBasicAuthValid } from '../src/auth'

describe('isBasicAuthValid', () => {
  it('allows requests when password protection is disabled', () => {
    expect(isBasicAuthValid(null)).toBe(true)
  })

  it('accepts the configured Basic authorization value', () => {
    expect(isBasicAuthValid('Basic YWRtaW46c2VjcmV0', 'admin:secret')).toBe(true)
  })

  it('rejects missing and incorrect credentials when protection is enabled', () => {
    expect(isBasicAuthValid(null, 'admin:secret')).toBe(false)
    expect(isBasicAuthValid('Basic d3Jvbmc6cGFzc3dvcmQ=', 'admin:secret')).toBe(false)
  })
})
