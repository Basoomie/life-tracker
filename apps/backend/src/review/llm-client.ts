// v2 §9.2 / §9.2 "fails safe under model substitution" — the only module that talks to
// Anthropic. Model is configurable via REVIEW_LLM_MODEL (no code freeze on today's model,
// per §CLAUDE.md v2 rule 11); the Anthropic client itself is injectable so tests never
// make a live network call (§CLAUDE.md: strict green gate, zero flaky tests, and per
// §9.6 Category 4 "no live model calls in CI").
//
// Forces a single tool call (emit_review) rather than free text, so the response is
// always either a well-formed structured object or absent — there is no free-form prose
// path for the model to slip an unstructured recommendation through on.
//
// Every failure mode (network error, API error, malformed/missing tool call, a field of
// the wrong type) degrades to { narrative: '', recommendations: [] } — NEVER a thrown
// error, and NEVER fabricated content. A weak or misbehaving model therefore yields fewer
// recommendations (verification in verification.ts drops anything that doesn't check out
// downstream too), never bad ones.

import Anthropic from '@anthropic-ai/sdk'
import type { BuiltPrompt } from './prompt-builder'
import { REVIEW_TOOL_NAME } from './prompt-builder'
import type { RawRecommendationCandidate, RawReviewOutput } from './types'

const EMPTY_OUTPUT: RawReviewOutput = { narrative: '', recommendations: [] }

// Minimal shape of what we actually use from the SDK client — lets tests inject a plain
// object instead of constructing a real Anthropic client.
export type ReviewLLMClient = {
  messages: {
    create: (params: unknown) => Promise<{ content: Array<{ type: string; input?: unknown }> }>
  }
}

export type ReviewLLMDeps = {
  client?: ReviewLLMClient
  model?: string
}

function resolveModel(deps?: ReviewLLMDeps): string {
  return deps?.model ?? process.env.REVIEW_LLM_MODEL ?? 'claude-opus-4-8'
}

function resolveClient(deps?: ReviewLLMDeps): ReviewLLMClient {
  return deps?.client ?? (new Anthropic() as unknown as ReviewLLMClient)
}

function isWellFormedCandidate(c: unknown): c is RawRecommendationCandidate {
  if (typeof c !== 'object' || c === null) return false
  const r = c as Record<string, unknown>
  return (
    typeof r.evidenceEntryId === 'string' &&
    typeof r.recommendationText === 'string' &&
    (r.confidence === 'low' || r.confidence === 'medium' || r.confidence === 'high') &&
    (r.targetedMetricFactId === null || typeof r.targetedMetricFactId === 'string')
  )
}

// Parses the tool_use input defensively — the model is untrusted, and per §9.2 a broken
// structured-output contract must degrade gracefully, never throw.
function parseToolInput(input: unknown): RawReviewOutput {
  if (typeof input !== 'object' || input === null) return EMPTY_OUTPUT
  const obj = input as Record<string, unknown>
  const narrative = typeof obj.narrative === 'string' ? obj.narrative : ''
  const recommendations = Array.isArray(obj.recommendations)
    ? obj.recommendations.filter(isWellFormedCandidate)
    : []
  return { narrative, recommendations }
}

export async function callReviewLLM(prompt: BuiltPrompt, deps?: ReviewLLMDeps): Promise<RawReviewOutput> {
  const client = resolveClient(deps)
  const model = resolveModel(deps)

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
    return EMPTY_OUTPUT
  }

  const toolUse = response.content?.find((b) => b.type === 'tool_use')
  if (!toolUse) return EMPTY_OUTPUT
  return parseToolInput(toolUse.input)
}
