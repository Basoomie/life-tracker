// v2 §9.2 / follow-up (provider neutrality) — the provider-neutral contract every LLM
// adapter implements.
//
// Contract: given a prompt, return a validated array of structured recommendations (and
// a narrative) — or return an empty array. HOW an adapter coaxes structure out of its
// provider (tool/function calling, JSON-schema-constrained response mode, or anything
// else a future provider supports) is that adapter's problem, not this interface's. This
// file — and everything upstream of it (prompt-builder.ts, generate.ts, verification.ts,
// render.ts) — must never mention a provider wire-format term (tool_use, input_schema,
// function_call, etc.). That is grep-tested in __tests__/review/llm-client.test.ts.
//
// generateRecommendations must never reject for "the model produced bad/malformed
// output" — that degrades to an empty RawReviewOutput (§9.2 "fails safe under model
// substitution"). It MAY reject for genuine transport/config failures the caller should
// see (e.g. the underlying HTTP call itself erroring) — llm-client.ts's dispatcher does
// not swallow those into false silence beyond what each adapter already guarantees.

import type { BuiltPrompt } from '../prompt-builder'
import type { RawReviewOutput } from '../types'

export interface LLMAdapter {
  generateRecommendations(prompt: BuiltPrompt): Promise<RawReviewOutput>
}

export type LLMProvider = 'anthropic' | 'openai-compatible'
