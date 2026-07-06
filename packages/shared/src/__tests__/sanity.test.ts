import { describe, it, expect } from 'vitest'
import type { HealthResponse } from '../health'

describe('shared package exports', () => {
  it('HealthResponse type is structurally correct', () => {
    // Compile-time proof: if this assignment is accepted, the type is exported correctly.
    const ok: HealthResponse = { status: 'ok', postgres: 'connected' }
    const err: HealthResponse = { status: 'error', postgres: 'disconnected' }
    expect(ok.status).toBe('ok')
    expect(err.postgres).toBe('disconnected')
  })
})
