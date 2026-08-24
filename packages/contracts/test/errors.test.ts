import { describe, expect, it } from 'vitest'
import { PandaError, PANDA_ERROR_CODES } from '../src'

describe('PandaError', () => {
  it('carries a stable code, name and message', () => {
    const error = new PandaError(PANDA_ERROR_CODES.kernelManifestInvalid, 'something broke')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
    expect(error.name).toBe('PandaError')
    expect(error.message).toBe('something broke')
  })

  it('exposes codes following the PANDA_<DOMAIN>_<REASON> convention', () => {
    for (const code of Object.values(PANDA_ERROR_CODES)) {
      expect(code).toMatch(/^PANDA_[A-Z]+(_[A-Z]+)+$/)
    }
  })
})
