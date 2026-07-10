// v2 §9.2 "fails safe under model substitution" / provider-neutrality follow-up — the
// OpenAI-compatible adapter (OpenAI, Gemini's compat endpoint, and local runtimes like
// Ollama/llama.cpp/LM Studio/vLLM all speak this one wire format).
// Determinism: fetch is always injected — zero live network access.

import { describe, it, expect, vi } from 'vitest'
import { createOpenAICompatibleAdapter } from '../../../review/llm/openai-compatible'
import { buildPrompt } from '../../../review/prompt-builder'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-07' }
const PROMPT = buildPrompt({ cadence: 'weekly', window: WINDOW, facts: [], evidence: [], feedForward: [] })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const VALID_OUTPUT = { narrative: 'steady week', recommendations: [{ evidenceEntryId: 'ev-1', recommendationText: 'x', confidence: 'medium', targetedMetricFactId: null }] }

describe('§CLAUDE.md v2 rule 11 — REVIEW_LLM_BASE_URL is required for this provider, and fails clearly (not silently)', () => {
  it('throws immediately when no baseURL is configured (opts or env)', () => {
    const original = process.env.REVIEW_LLM_BASE_URL
    delete process.env.REVIEW_LLM_BASE_URL
    try {
      expect(() => createOpenAICompatibleAdapter({ fetchImpl: vi.fn() as unknown as typeof fetch })).toThrow(/REVIEW_LLM_BASE_URL/)
    } finally {
      if (original !== undefined) process.env.REVIEW_LLM_BASE_URL = original
    }
  })
})

describe('tool-calling path', () => {
  it('a model that uses the tool correctly yields recommendations from a single request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(VALID_OUTPUT) } }] } }],
    }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result.narrative).toBe('steady week')
    expect(result.recommendations).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends an OpenAI-style function tool with tool_choice forcing emit_review', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(VALID_OUTPUT) } }] } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', model: 'llama3.1', fetchImpl: fetchImpl as unknown as typeof fetch })
    await adapter.generateRecommendations(PROMPT)
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('llama3.1')
    expect(body.tools[0].function.name).toBe('emit_review')
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'emit_review' } })
  })

  it('§9.2 fails safe: the tool WAS called but its arguments are unparseable JSON — empty output, no fallback attempt', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: '{not valid json' } }] } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result).toEqual({ narrative: '', recommendations: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // tool calling "worked" (was exercised); no need to fall back
  })

  it('a transport-level failure (network down) yields empty output with no fallback attempt', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => { throw new Error('ECONNREFUSED') })
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result).toEqual({ narrative: '', recommendations: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // a retry against the same unreachable host wouldn't help
  })
})

describe('§9.2 "a model that fails tool-calling but supports JSON mode still yields recommendations"', () => {
  it('a non-2xx response to the tool-calling attempt falls back to JSON mode, which succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unknown field: tools' }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result.recommendations).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // The second (fallback) request must not still be asking for tools.
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
    const secondBody = JSON.parse(secondInit.body as string)
    expect(secondBody.tools).toBeUndefined()
    expect(secondBody.response_format).toEqual({ type: 'json_object' })
  })

  it('a 2xx response where the model never used the tool falls back to JSON mode, which succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'I will just answer in plain text.' } }] })) // no tool_calls
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result.recommendations).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('strips a markdown code fence around the JSON-mode response before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```'
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: {} }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: fenced } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result.recommendations).toHaveLength(1)
  })

  it('both tool-calling and JSON mode fail (e.g. the model is simply too weak) — empty output, never a thrown error', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: {} }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'not json, sorry' } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result).toEqual({ narrative: '', recommendations: [] })
  })

  it('a non-2xx response from the JSON-mode fallback itself also degrades to empty output', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: {} }] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'server error' }, 500))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await adapter.generateRecommendations(PROMPT)
    expect(result).toEqual({ narrative: '', recommendations: [] })
  })
})

describe('configurability', () => {
  it('sends an Authorization header when an API key is configured, and omits it when not', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(VALID_OUTPUT) } }] } }] }))
    const withKey = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', apiKey: 'sk-test-123', fetchImpl: fetchImpl as unknown as typeof fetch })
    await withKey.generateRecommendations(PROMPT)
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-123')

    fetchImpl.mockClear()
    const withoutKey = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: fetchImpl as unknown as typeof fetch })
    await withoutKey.generateRecommendations(PROMPT)
    const [, init2] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init2.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('strips a trailing slash from the configured base URL', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(VALID_OUTPUT) } }] } }] }))
    const adapter = createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1/', fetchImpl: fetchImpl as unknown as typeof fetch })
    await adapter.generateRecommendations(PROMPT)
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
  })
})

describe('§CLAUDE.md determinism — same mocked input, same output, every time', () => {
  it('two calls with identical mocked responses produce identical parsed output', async () => {
    const makeFetch = () => vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(VALID_OUTPUT) } }] } }] }))
    const r1 = await createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: makeFetch() as unknown as typeof fetch }).generateRecommendations(PROMPT)
    const r2 = await createOpenAICompatibleAdapter({ baseURL: 'http://localhost:11434/v1', fetchImpl: makeFetch() as unknown as typeof fetch }).generateRecommendations(PROMPT)
    expect(r1).toEqual(r2)
  })
})
