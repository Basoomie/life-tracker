// v2 §9.2 / provider-neutrality follow-up — the OpenAI-compatible adapter.
//
// One adapter covers OpenAI itself, Google's Gemini OpenAI-compatible endpoint, and every
// local runtime that emulates the chat-completions wire format (Ollama, llama.cpp, LM
// Studio, vLLM). REVIEW_LLM_BASE_URL is what actually distinguishes them — this file has
// no provider-specific branching at all.
//
// Model support for structured output varies a lot across this range: OpenAI and most
// hosted models support tool/function calling reliably; many small local models support
// JSON-schema-constrained response mode ("JSON mode") but not reliable tool calling. This
// adapter tries tool calling first and falls back to JSON mode when the model doesn't
// exercise the tool — it does not assume either mechanism is available.
//
// Raw fetch, not the `openai` SDK: this needs to work generically against arbitrary
// base URLs (including ones the SDK was never pointed at), and the fallback logic needs
// fine control over exactly what counts as "tool calling didn't work here." Mirrors the
// existing injectable-fetch convention already used in evidence/pubmed-client.ts.

import { REVIEW_TOOL_NAME, type BuiltPrompt } from '../prompt-builder'
import type { RawReviewOutput } from '../types'
import type { LLMAdapter } from './types'
import { EMPTY_OUTPUT, tryParseJson, validateReviewOutput } from './validate'

export type OpenAICompatibleAdapterOptions = {
  fetchImpl?: typeof fetch
  baseURL?: string
  model?: string
  apiKey?: string
}

type ResolvedConfig = {
  fetchImpl: typeof fetch
  baseURL: string
  model?: string
  apiKey?: string
}

// Treats an unset OR empty-string env var as "not configured" — matches docker-compose's
// `${VAR:-}` passthrough convention (see evidence/pubmed-client.ts's identical helper).
function envOrUndefined(value: string | undefined): string | undefined {
  return value ? value : undefined
}

function resolveConfig(opts?: OpenAICompatibleAdapterOptions): ResolvedConfig {
  const baseURL = opts?.baseURL ?? envOrUndefined(process.env.REVIEW_LLM_BASE_URL)
  if (!baseURL) {
    // A missing endpoint is a deployment configuration error, not "the model behaved
    // badly" — it must fail clearly and immediately, not degrade into silent empty
    // output (which would make a typo'd .env indistinguishable from a working-but-weak
    // model). Distinct failure class from §9.2's fails-safe guarantee, which is about
    // MODEL output, not deployment config.
    throw new Error(
      'REVIEW_LLM_BASE_URL is required when REVIEW_LLM_PROVIDER=openai-compatible ' +
      '(point it at OpenAI, a Gemini OpenAI-compatible endpoint, or a local runtime such as Ollama/llama.cpp/LM Studio/vLLM).'
    )
  }
  return {
    fetchImpl: opts?.fetchImpl ?? fetch,
    baseURL: baseURL.replace(/\/+$/, ''),
    model: opts?.model ?? envOrUndefined(process.env.REVIEW_LLM_MODEL),
    apiKey: opts?.apiKey ?? envOrUndefined(process.env.REVIEW_LLM_API_KEY),
  }
}

function buildHeaders(config: ResolvedConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`
  return headers
}

// Some local models wrap JSON in a markdown code fence despite being told not to —
// stripping it is exactly the "handle gracefully, don't assume" posture the design asks
// for. A schema-validation concern this is not; it lives here, not in validate.ts.
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1] : trimmed
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: Array<{ function?: { arguments?: string } }>
    }
  }>
}

// Returns the parsed+validated output, or the sentinel 'unsupported' meaning "this model /
// backend didn't exercise tool calling — try JSON mode next." A genuine transport failure
// (network down, DNS failure) returns EMPTY_OUTPUT directly rather than 'unsupported',
// since a JSON-mode retry against the same unreachable host would fail identically.
async function attemptToolCalling(prompt: BuiltPrompt, config: ResolvedConfig): Promise<RawReviewOutput | 'unsupported'> {
  let res: Response
  try {
    res = await config.fetchImpl(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.userMessage },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: REVIEW_TOOL_NAME,
              description: 'Emit the synthesized review narrative and any evidence-backed recommendations.',
              parameters: prompt.inputSchema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: REVIEW_TOOL_NAME } },
      }),
    })
  } catch {
    return EMPTY_OUTPUT
  }

  // Some minimal backends 4xx/5xx on an unrecognized `tools` field entirely — treat that
  // the same as "tool calling isn't supported here," not as a hard failure.
  if (!res.ok) return 'unsupported'

  let json: ChatCompletionResponse
  try {
    json = (await res.json()) as ChatCompletionResponse
  } catch {
    return 'unsupported'
  }

  const toolCall = json.choices?.[0]?.message?.tool_calls?.[0]
  if (!toolCall) return 'unsupported' // model responded without ever using the tool

  // The tool WAS called — that's proof this backend supports tool calling, so from here
  // on it's a §9.2 fails-safe case (bad arguments), not a fallback case.
  const parsed = tryParseJson(toolCall.function?.arguments)
  if (parsed === undefined) return EMPTY_OUTPUT
  return validateReviewOutput(parsed)
}

async function attemptJsonMode(prompt: BuiltPrompt, config: ResolvedConfig): Promise<RawReviewOutput> {
  try {
    const schemaHint = `\n\nRespond with ONLY a single JSON object matching this schema — no other text, no markdown fences:\n${JSON.stringify(prompt.inputSchema)}`
    const res = await config.fetchImpl(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: prompt.system + schemaHint },
          { role: 'user', content: prompt.userMessage },
        ],
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) return EMPTY_OUTPUT

    const json = (await res.json()) as ChatCompletionResponse
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') return EMPTY_OUTPUT

    const parsed = tryParseJson(stripCodeFence(content))
    if (parsed === undefined) return EMPTY_OUTPUT
    return validateReviewOutput(parsed)
  } catch {
    return EMPTY_OUTPUT
  }
}

export function createOpenAICompatibleAdapter(opts?: OpenAICompatibleAdapterOptions): LLMAdapter {
  const config = resolveConfig(opts)

  return {
    async generateRecommendations(prompt: BuiltPrompt): Promise<RawReviewOutput> {
      const toolResult = await attemptToolCalling(prompt, config)
      if (toolResult !== 'unsupported') return toolResult
      return attemptJsonMode(prompt, config)
    },
  }
}
