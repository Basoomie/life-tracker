// v2 §9.2 — Anthropic adapter: forced tool-use.
//
// This is the ONLY file in the review engine allowed to know what a "tool_use content
// block" is — the LLMAdapter interface (./types.ts) and everything upstream of it
// (prompt-builder.ts, generate.ts) are provider-neutral by construction. How this
// specific provider is made to emit structured output is entirely this file's problem.
//
// Model is configurable (REVIEW_LLM_MODEL, no default frozen into a specific version
// beyond a sane out-of-the-box choice — §CLAUDE.md v2 rule 11). The Anthropic client is
// injectable so tests never make a live network call.

import Anthropic from '@anthropic-ai/sdk'
import { REVIEW_TOOL_NAME, type BuiltPrompt } from '../prompt-builder'
import type { RawReviewOutput } from '../types'
import type { LLMAdapter } from './types'
import { EMPTY_OUTPUT, validateReviewOutput } from './validate'

// Minimal shape of what we actually use from the SDK client — lets tests inject a plain
// object instead of constructing a real Anthropic client.
export type AnthropicClientLike = {
  messages: {
    create: (params: unknown) => Promise<{ content: Array<{ type: string; input?: unknown }> }>
  }
}

export type AnthropicAdapterOptions = {
  client?: AnthropicClientLike
  model?: string
  apiKey?: string
}

function resolveModel(opts?: AnthropicAdapterOptions): string {
  return opts?.model ?? process.env.REVIEW_LLM_MODEL ?? 'claude-opus-4-8'
}

function resolveClient(opts?: AnthropicAdapterOptions): AnthropicClientLike {
  if (opts?.client) return opts.client
  // Constructing the client does NOT require an API key to be present (the SDK only
  // resolves auth when a request is actually made) — so a missing ANTHROPIC_API_KEY
  // never blocks app boot, only the eventual call. See resolveClient's caller.
  return new Anthropic({ apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY }) as unknown as AnthropicClientLike
}

export function createAnthropicAdapter(opts?: AnthropicAdapterOptions): LLMAdapter {
  return {
    async generateRecommendations(prompt: BuiltPrompt): Promise<RawReviewOutput> {
      const client = resolveClient(opts)
      const model = resolveModel(opts)

      let response: { content: Array<{ type: string; input?: unknown }> }
      try {
        response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.userMessage }],
          tools: [
            {
              name: REVIEW_TOOL_NAME,
              description: 'Emit the synthesized review narrative and any evidence-backed recommendations.',
              input_schema: prompt.inputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME },
        })
      } catch {
        // Network failure, API error, or a missing/invalid API key all land here — every
        // one of them degrades to "no recommendations this period," never a crash.
        return EMPTY_OUTPUT
      }

      const toolUse = response.content?.find((b) => b.type === 'tool_use')
      if (!toolUse) return EMPTY_OUTPUT
      return validateReviewOutput(toolUse.input)
    },
  }
}
