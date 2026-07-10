// v2 §9.2 "fails safe under model substitution" / §9.6 Category 4 — llm-client.ts.
// Determinism: the real Anthropic client is never constructed in these tests — every
// test injects a fake client, so there is zero live network access, per §CLAUDE.md's
// anti-flake rule and §9.6 Category 4's "no live model calls in CI".

import { describe, it, expect, vi } from 'vitest'
import { callReviewLLM, type ReviewLLMClient } from '../../review/llm-client'
import { buildPrompt } from '../../review/prompt-builder'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-07' }
const PROMPT = buildPrompt({ cadence: 'weekly', window: WINDOW, facts: [], evidence: [], feedForward: [] })

function fakeClient(response: unknown): ReviewLLMClient {
  return { messages: { create: vi.fn(async () => response as never) } }
}

describe('§9.2 model configurability — REVIEW_LLM_MODEL is read, never hardcoded', () => {
  it('passes the configured model through to the API call', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use', input: { narrative: '', recommendations: [] } }] }))
    await callReviewLLM(PROMPT, { client: { messages: { create } }, model: 'claude-haiku-4-5' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5' }))
  })

  it('falls back to REVIEW_LLM_MODEL env var, then to a sane default, when no model is injected', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use', input: { narrative: '', recommendations: [] } }] }))
    const original = process.env.REVIEW_LLM_MODEL
    process.env.REVIEW_LLM_MODEL = 'claude-sonnet-5'
    try {
      await callReviewLLM(PROMPT, { client: { messages: { create } } })
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }))
    } finally {
      if (original === undefined) delete process.env.REVIEW_LLM_MODEL
      else process.env.REVIEW_LLM_MODEL = original
    }
  })

  it('forces the emit_review tool via tool_choice — the model cannot respond with free text instead', async () => {
    const create = vi.fn(async (_params: unknown) => ({ content: [{ type: 'tool_use', input: { narrative: '', recommendations: [] } }] }))
    await callReviewLLM(PROMPT, { client: { messages: { create } } })
    const params = create.mock.calls[0][0] as { tool_choice: { type: string; name: string } }
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'emit_review' })
  })
})

describe('§9.2 "fails safe under model substitution" — malformed / missing output degrades gracefully, never throws', () => {
  it('no tool_use block at all (model answered in plain text instead) yields empty output', async () => {
    const client = fakeClient({ content: [{ type: 'text', text: 'sorry, I will just talk instead' }] })
    const result = await callReviewLLM(PROMPT, { client })
    expect(result).toEqual({ narrative: '', recommendations: [] })
  })

  it('a tool_use block with a non-object input yields empty output', async () => {
    const client = fakeClient({ content: [{ type: 'tool_use', input: 'not an object' }] })
    const result = await callReviewLLM(PROMPT, { client })
    expect(result).toEqual({ narrative: '', recommendations: [] })
  })

  it('recommendations missing required fields are dropped individually, not the whole response', async () => {
    const client = fakeClient({
      content: [{
        type: 'tool_use',
        input: {
          narrative: 'Adherence looks steady this week.',
          recommendations: [
            { evidenceEntryId: 'ev-1', recommendationText: 'Anchor it to a fixed time', confidence: 'medium', targetedMetricFactId: null },
            { evidenceEntryId: 'ev-2', recommendationText: 'missing confidence field', targetedMetricFactId: null },
            { recommendationText: 'missing evidenceEntryId', confidence: 'low', targetedMetricFactId: null },
          ],
        },
      }],
    })
    const result = await callReviewLLM(PROMPT, { client })
    expect(result.narrative).toBe('Adherence looks steady this week.')
    expect(result.recommendations).toHaveLength(1)
    expect(result.recommendations[0].evidenceEntryId).toBe('ev-1')
  })

  it('a thrown network/API error degrades to empty output rather than propagating', async () => {
    const client: ReviewLLMClient = { messages: { create: vi.fn(async () => { throw new Error('network down') }) } }
    const result = await callReviewLLM(PROMPT, { client })
    expect(result).toEqual({ narrative: '', recommendations: [] })
  })

  it('a non-string narrative field falls back to an empty string rather than propagating garbage', async () => {
    const client = fakeClient({ content: [{ type: 'tool_use', input: { narrative: 12345, recommendations: [] } }] })
    const result = await callReviewLLM(PROMPT, { client })
    expect(result.narrative).toBe('')
  })
})

describe('§CLAUDE.md determinism — same mocked input, same output, every time', () => {
  it('two calls with identical mocked responses produce identical parsed output', async () => {
    const response = { content: [{ type: 'tool_use', input: { narrative: 'steady', recommendations: [] } }] }
    const r1 = await callReviewLLM(PROMPT, { client: fakeClient(response) })
    const r2 = await callReviewLLM(PROMPT, { client: fakeClient(response) })
    expect(r1).toEqual(r2)
  })
})
