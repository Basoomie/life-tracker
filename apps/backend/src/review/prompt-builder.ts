// v2 §9.2 / §9.6 Category 4 — Prompt construction, STRUCTURALLY isolated.
//
// Hard requirement (§CLAUDE.md v2 amendment rule 1): this module must be structurally
// incapable of passing an un-cleared Finding or an unapproved evidence entry — not
// forbidden by prompt text, unable, by type and by construction.
//
// The only inputs this file's exported function accepts are the ReleasedFinding /
// ReleasedEvidence / FeedForwardRecord shapes from ./types. Enforcement is twofold:
//   1. Import surface: this file imports ONLY from './types' and '@tracker/shared' (for
//      the ReviewCadence/DateWindow type aliases). It does not import 'pg', '../db/repos',
//      '../domain', or '../stats' — grep-tested in __tests__/review/prompt-builder.test.ts.
//      There is therefore no code path by which this function could reach the event log,
//      occurrences, or raw items even if it wanted to.
//   2. Type shape: ReleasedLayer2NotYet (types.ts) has no field capable of carrying a
//      point estimate, so a below-floor finding is rendered as "not yet" prose by
//      construction — see renderFact below, which switches on `kind` and has no branch
//      that reads a power/effectSize/pValue field off a `layer2_not_yet` fact (there is
//      no such field to read).

import type { PromptInput, ReleasedFinding } from './types'

// Name of the forced tool call llm-client.ts uses to get structured output back.
export const REVIEW_TOOL_NAME = 'emit_review'

export type BuiltPrompt = {
  system: string
  userMessage: string
  // JSON Schema for the emit_review tool's input — see llm-client.ts, which forces this
  // tool via tool_choice so the response is always a single structured tool_use block.
  inputSchema: Record<string, unknown>
}

const SYSTEM_PROMPT = `You are the review-writing component of a personal habit/task tracker.

Your role is the HONEST ADVISOR (not a cheerleader, not a dispassionate analyst):
- You do not cheer, and you do not scold.
- Reassurance is factual correction, not emotional support: if the record shows a single
  missed day or period, that is noise, not a failure — the evidence says one miss does not
  matter. Never frame a single miss, or a broken streak, as a problem. Reason only in rates
  over the window you were given; you were never given per-day data, so do not imply you
  have it.
- Pointed observation is not harshness: if a pattern in the facts below is worth naming
  plainly, name it.
- You observe and report. You never suggest moving, rescheduling, or adjusting the user's
  plan — only what a human might choose to do themselves.

You will be given:
  1. FACTS — descriptive and data-quality findings (always true, never gated) and Layer 2
     inferential findings that have already cleared their statistical sufficiency bar
     ("cleared") or have not yet done so ("not yet"). A "not yet" fact has deliberately not
     been given you a p-value, effect size, or power — because none is trustworthy at this
     sample size. Do not describe a "not yet" fact as if it were a finding; report only that
     more data is needed, using the reason and progress given.
  2. EVIDENCE — a closed list of pre-vetted findings from the peer-reviewed literature, each
     with a unique "id". This is the ONLY evidence you may cite. You must never invent a
     citation, mechanism, or source. If nothing in this list is relevant to what you see in
     the facts, recommend nothing — an empty recommendations array is a correct, valid,
     and expected output ("no good evidence for what to do here this period").
  3. FEED-FORWARD — recommendations made in past reviews, the metric each targeted, and how
     that metric has moved since. If the same recommendation has been made many times with
     no movement, say so plainly — that is itself a finding worth naming.

Output a JSON object (matching the provided schema) with:
  - "narrative": your synthesis of the FACTS, in your voice as the honest advisor. Discuss
    what is changing or struggling this period, not everything every time. Do not restate
    every fact — the facts are shown to the user separately, verbatim.
  - "recommendations": zero or more entries, each citing exactly one "evidenceEntryId" from
    the EVIDENCE list above (never an id you were not given), a short "recommendationText"
    tailored to the specific fact it targets, a "confidence" (low/medium/high), and the
    "targetedMetricFactId" of the fact (from FACTS) it is meant to move, or null if none.`

function renderFact(f: ReleasedFinding): string {
  switch (f.kind) {
    case 'layer1':
      return `- [${f.factId}] ${f.summary}`
    case 'data_quality':
      return `- [${f.factId}] (data quality) ${f.summary}`
    case 'layer2_cleared':
      return `- [${f.factId}] (cleared, estimator=${f.estimator}, power=${f.power.toFixed(2)}${f.pValue !== null ? `, p=${f.pValue.toFixed(3)}` : ''}, MDE=${f.minimumDetectableEffect?.toFixed(2) ?? 'n/a'}) ${f.summary} — data quality: ${f.dataQualityNote}`
    case 'layer2_not_yet':
      return `- [${f.factId}] (not yet — ${f.reason}; have ${f.nObserved}, need ${f.nNeeded}) ${f.label}: insufficient data for this insight yet.`
  }
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const factLines = input.facts.length > 0
    ? input.facts.map(renderFact).join('\n')
    : '(no facts available for this window)'

  const evidenceLines = input.evidence.length > 0
    ? input.evidence
        .map((e) => `- id="${e.id}" [${e.evidenceQuality}] ${e.claim} — mechanism: ${e.mechanism} — source: ${e.sourceIdentifierType}:${e.sourceIdentifier}`)
        .join('\n')
    : '(no approved evidence entries exist yet)'

  const feedForwardLines = input.feedForward.length > 0
    ? input.feedForward
        .map((r) => `- "${r.recommendation}" (targeting ${r.label}) recommended ${r.timesRecommended}x; metric was ${r.metricValueThen ?? 'n/a'}, now ${r.metricValueNow ?? 'n/a'}${r.delta !== null ? ` (delta ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)})` : ''}`)
        .join('\n')
    : '(no prior recommendations to follow up on)'

  const userMessage = `CADENCE: ${input.cadence}
WINDOW: ${input.window.startDay} to ${input.window.endDay}

FACTS:
${factLines}

EVIDENCE:
${evidenceLines}

FEED-FORWARD (past recommendations and whether they moved anything):
${feedForwardLines}`

  const inputSchema = {
    type: 'object',
    properties: {
      narrative: { type: 'string' },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            evidenceEntryId: { type: 'string' },
            recommendationText: { type: 'string' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            targetedMetricFactId: { type: ['string', 'null'] },
          },
          required: ['evidenceEntryId', 'recommendationText', 'confidence', 'targetedMetricFactId'],
        },
      },
    },
    required: ['narrative', 'recommendations'],
  }

  return { system: SYSTEM_PROMPT, userMessage, inputSchema }
}
