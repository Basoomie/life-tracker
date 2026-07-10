// v2 §CLAUDE.md v2 rule 11 / §9.2 / §9.6 Category 4 — llm-client.ts: the thin dispatcher.
// Per-adapter behavior (tool-calling, JSON-mode fallback, fails-safe) is tested in
// __tests__/review/llm/{anthropic-adapter,openai-compatible-adapter}.test.ts — this file
// covers provider SELECTION and the guarantees that must hold regardless of provider.

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { callReviewLLM } from '../../review/llm-client'
import { buildPrompt } from '../../review/prompt-builder'
import { verifyRecommendations } from '../../review/verification'
import type { LLMAdapter } from '../../review/llm/types'
import type { ReleasedEvidence, ReleasedFinding } from '../../review/types'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-07' }
const PROMPT = buildPrompt({ cadence: 'weekly', window: WINDOW, facts: [], evidence: [], feedForward: [] })

function fakeAdapter(result: unknown): LLMAdapter {
  return { generateRecommendations: vi.fn(async () => result as never) }
}

describe('§CLAUDE.md v2 rule 11 — provider is selected by env, defaulting to anthropic', () => {
  it('an injected adapter overrides provider resolution entirely', async () => {
    const adapter = fakeAdapter({ narrative: 'via injected adapter', recommendations: [] })
    const result = await callReviewLLM(PROMPT, { adapter })
    expect(result.narrative).toBe('via injected adapter')
    expect(adapter.generateRecommendations).toHaveBeenCalledWith(PROMPT)
  })

  it('provider: "anthropic" dispatches to the Anthropic adapter (verified via its injected client)', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use', input: { narrative: 'anthropic path', recommendations: [] } }] }))
    const result = await callReviewLLM(PROMPT, { provider: 'anthropic', anthropic: { client: { messages: { create } } } })
    expect(result.narrative).toBe('anthropic path')
    expect(create).toHaveBeenCalled()
  })

  it('provider: "openai-compatible" dispatches to that adapter (verified via its injected fetch)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ narrative: 'openai-compatible path', recommendations: [] }) } }] } }],
    }), { status: 200 }))
    const result = await callReviewLLM(PROMPT, {
      provider: 'openai-compatible',
      openaiCompatible: { baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch },
    })
    expect(result.narrative).toBe('openai-compatible path')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('an unrecognized provider fails CLEARLY — it rejects, it does not silently fall back to anthropic', async () => {
    await expect(callReviewLLM(PROMPT, { provider: 'not-a-real-provider' as never })).rejects.toThrow(/Unknown REVIEW_LLM_PROVIDER/)
  })

  it('reads REVIEW_LLM_PROVIDER from the environment when not overridden by deps', async () => {
    const original = process.env.REVIEW_LLM_PROVIDER
    process.env.REVIEW_LLM_PROVIDER = 'openai-compatible'
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ narrative: 'from env', recommendations: [] }) } }] } }],
      }), { status: 200 }))
      const result = await callReviewLLM(PROMPT, { openaiCompatible: { baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch } })
      expect(result.narrative).toBe('from env')
    } finally {
      if (original === undefined) delete process.env.REVIEW_LLM_PROVIDER
      else process.env.REVIEW_LLM_PROVIDER = original
    }
  })
})

describe('§CLAUDE.md v2 rule 1 follow-up — the engine has no provider wire-format leakage', () => {
  const engineFiles = [
    '../../review/generate.ts',
    '../../review/prompt-builder.ts',
    '../../review/verification.ts',
    '../../review/render.ts',
    '../../review/schedule.ts',
    '../../review/feed-forward.ts',
    '../../review/llm/types.ts',
    '../../review/llm-client.ts',
  ]
  const wireFormatTerms = ['tool_use', 'input_schema', 'function_call', 'tool_choice']

  it.each(engineFiles)('%s never mentions a provider wire-format term in actual code', (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, file), 'utf8')
    // Strip full-line comments — this test is about the CODE, not about being able to
    // discuss the constraint in a doc comment (which several of these files do, by name,
    // to explain why the constraint exists).
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const term of wireFormatTerms) {
      expect(code, `${file} should not mention "${term}" outside of comments`).not.toContain(term)
    }
  })
})

describe('§9.2 — missing API key fails only the review call, never app boot', () => {
  it('the app builds successfully with no LLM provider, model, base URL, or API key configured', async () => {
    const saved = {
      REVIEW_LLM_PROVIDER: process.env.REVIEW_LLM_PROVIDER,
      REVIEW_LLM_MODEL: process.env.REVIEW_LLM_MODEL,
      REVIEW_LLM_BASE_URL: process.env.REVIEW_LLM_BASE_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      REVIEW_LLM_API_KEY: process.env.REVIEW_LLM_API_KEY,
    }
    delete process.env.REVIEW_LLM_PROVIDER
    delete process.env.REVIEW_LLM_MODEL
    delete process.env.REVIEW_LLM_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.REVIEW_LLM_API_KEY
    try {
      const { buildApp } = await import('../../app')
      const app = await buildApp(async () => 'test-user-id')
      expect(app).toBeDefined()
      await app.close()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('a missing ANTHROPIC_API_KEY degrades the anthropic adapter to empty output, not a crash', async () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      // No client injected: this constructs a real (keyless) Anthropic client and lets
      // the SDK's own auth-resolution failure surface — caught internally by the
      // adapter's fails-safe try/catch, same as any other transport/API error.
      const result = await callReviewLLM(PROMPT, { provider: 'anthropic' })
      expect(result).toEqual({ narrative: '', recommendations: [] })
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = original
    }
  })
})

describe('§9.4 gate still holds through the new client layer, for every adapter', () => {
  const evidence: ReleasedEvidence[] = [{
    id: 'ev-real', claim: 'real claim', mechanism: 'real mechanism',
    sourceIdentifier: '23211256', sourceIdentifierType: 'pmid', evidenceQuality: 'observational',
    groundedJustification: 'real justification',
  }]
  const facts: ReleasedFinding[] = []

  it('a fabricated source_identifier from the anthropic adapter is dropped before prose', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'tool_use', input: { narrative: '', recommendations: [{ evidenceEntryId: 'ev-FABRICATED', recommendationText: 'x', confidence: 'high', targetedMetricFactId: null }] } }],
    }))
    const raw = await callReviewLLM(PROMPT, { provider: 'anthropic', anthropic: { client: { messages: { create } } } })
    const verified = verifyRecommendations(raw.recommendations, evidence, facts)
    expect(verified).toEqual([])
  })

  it('a fabricated source_identifier from the openai-compatible adapter (tool-calling path) is dropped before prose', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ narrative: '', recommendations: [{ evidenceEntryId: 'ev-FABRICATED', recommendationText: 'x', confidence: 'high', targetedMetricFactId: null }] }) } }] } }],
    }), { status: 200 }))
    const raw = await callReviewLLM(PROMPT, { provider: 'openai-compatible', openaiCompatible: { baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch } })
    const verified = verifyRecommendations(raw.recommendations, evidence, facts)
    expect(verified).toEqual([])
  })

  it('a fabricated source_identifier from the openai-compatible adapter (JSON-mode fallback path) is dropped before prose', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) // tool calling unsupported
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ narrative: '', recommendations: [{ evidenceEntryId: 'ev-FABRICATED', recommendationText: 'x', confidence: 'high', targetedMetricFactId: null }] }) } }],
      }), { status: 200 }))
    const raw = await callReviewLLM(PROMPT, { provider: 'openai-compatible', openaiCompatible: { baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch } })
    const verified = verifyRecommendations(raw.recommendations, evidence, facts)
    expect(verified).toEqual([])
  })

  it('a legitimate source_identifier from any adapter still survives verification (the gate isn\'t over-tightened)', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'tool_use', input: { narrative: '', recommendations: [{ evidenceEntryId: 'ev-real', recommendationText: 'x', confidence: 'high', targetedMetricFactId: null }] } }],
    }))
    const raw = await callReviewLLM(PROMPT, { provider: 'anthropic', anthropic: { client: { messages: { create } } } })
    const verified = verifyRecommendations(raw.recommendations, evidence, facts)
    expect(verified).toHaveLength(1)
    expect(verified[0].sourceIdentifier).toBe('23211256')
  })
})
