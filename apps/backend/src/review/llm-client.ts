// v2 §9.2 / provider-neutrality follow-up — the thin dispatcher.
//
// This module used to BE the Anthropic client directly; it is now just provider
// selection. All provider-specific wire format lives in ./llm/anthropic.ts and
// ./llm/openai-compatible.ts — this file (and everything upstream of it: generate.ts,
// prompt-builder.ts, verification.ts, render.ts) never mentions tool_use, input_schema,
// or function_call. That is grep-tested in __tests__/review/llm-client.test.ts.
//
// Two distinct failure classes, deliberately handled differently:
//   - Provider MISCONFIGURATION (an unrecognized REVIEW_LLM_PROVIDER, or a missing
//     REVIEW_LLM_BASE_URL for openai-compatible) is a deployment bug. It fails loudly —
//     callReviewLLM rejects — so it's visible immediately rather than silently masquerading
//     as "the model had nothing to say." It never reaches app boot (routes/admin.ts is the
//     only caller, and only when a review is actually requested), so a bad or absent LLM
//     config still lets the app start.
//   - MODEL BEHAVIOR (a weak/local model that mishandles structured output, a network
//     hiccup, an invalid API key) is §9.2's "fails safe under model substitution" — each
//     adapter degrades that to an empty RawReviewOutput, never a thrown error.

import type { BuiltPrompt } from './prompt-builder'
import type { RawReviewOutput } from './types'
import type { LLMAdapter, LLMProvider } from './llm/types'
import { createAnthropicAdapter, type AnthropicAdapterOptions } from './llm/anthropic'
import { createOpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from './llm/openai-compatible'

export type ReviewLLMDeps = {
  // Full override — tests (and any future caller that wants total control) inject a
  // ready-made adapter directly, bypassing provider resolution entirely.
  adapter?: LLMAdapter
  provider?: LLMProvider
  anthropic?: AnthropicAdapterOptions
  openaiCompatible?: OpenAICompatibleAdapterOptions
}

function resolveProvider(deps?: ReviewLLMDeps): string {
  return deps?.provider ?? process.env.REVIEW_LLM_PROVIDER ?? 'anthropic'
}

function createAdapter(deps?: ReviewLLMDeps): LLMAdapter {
  const provider = resolveProvider(deps)
  switch (provider) {
    case 'anthropic':
      return createAnthropicAdapter(deps?.anthropic)
    case 'openai-compatible':
      return createOpenAICompatibleAdapter(deps?.openaiCompatible)
    default:
      throw new Error(
        `Unknown REVIEW_LLM_PROVIDER: "${provider}" (expected "anthropic" or "openai-compatible")`
      )
  }
}

export async function callReviewLLM(prompt: BuiltPrompt, deps?: ReviewLLMDeps): Promise<RawReviewOutput> {
  const adapter = deps?.adapter ?? createAdapter(deps)
  return adapter.generateRecommendations(prompt)
}
