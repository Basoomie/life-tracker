// v2 §9.4 item 5 — "User-facing prose is RENDERED FROM the verified structure, never
// freely generated alongside it." This is the only place a Review's display text is
// assembled, and it only reads already-verified/released structure: ReleasedFinding[]
// (Layer 1/1.5/2, already gated by release.ts), the LLM's narrative (already input-gated
// by the Layer Rule — the model can only narrate facts it was given), and Recommendation[]
// (already verification-gated by verification.ts). Nothing here talks to the network, the
// DB, or the LLM.
//
// Zero recommendations renders an explicit, honest line rather than an empty section —
// per §9.4 item 6, "no good evidence for what to do here" is a valid, expected outcome.

import type { ReviewCadence, DateWindow, Recommendation } from '@tracker/shared'
import type { ReleasedFinding } from './types'

function renderFactLine(f: ReleasedFinding): string {
  switch (f.kind) {
    case 'layer1':
      return `- ${f.summary}`
    case 'data_quality':
      return `- (logging health) ${f.summary}`
    case 'layer2_cleared':
      return `- ${f.summary}`
    case 'layer2_not_yet':
      return `- ${f.label}: not yet — ${f.reason} (have ${f.nObserved}, need ${f.nNeeded})`
  }
}

function renderRecommendation(r: Recommendation): string {
  const target = r.targetedMetricLabel ? ` [targeting: ${r.targetedMetricLabel}]` : ''
  return (
    `- ${r.recommendation}${target}\n` +
    `  Why: ${r.mechanism} (${r.evidenceQuality}; ${r.sourceIdentifierType}:${r.sourceIdentifier}; confidence: ${r.confidence})\n` +
    `  What the source reports: ${r.groundedJustification}`
  )
}

export function renderReviewProse(review: {
  cadence: ReviewCadence
  window: DateWindow
  facts: ReleasedFinding[]
  narrative: string
  recommendations: Recommendation[]
}): string {
  const header = `# ${review.cadence[0].toUpperCase()}${review.cadence.slice(1)} review — ${review.window.startDay} to ${review.window.endDay}`

  const factsSection = review.facts.length > 0
    ? review.facts.map(renderFactLine).join('\n')
    : '(no facts available for this window)'

  const narrativeSection = review.narrative.trim().length > 0
    ? review.narrative.trim()
    : ''

  const recommendationsSection = review.recommendations.length > 0
    ? review.recommendations.map(renderRecommendation).join('\n\n')
    : 'No good evidence for what to do here this period.'

  const sections = [
    header,
    '## Facts',
    factsSection,
    ...(narrativeSection ? ['## Observations', narrativeSection] : []),
    '## Recommendations',
    recommendationsSection,
  ]

  return sections.join('\n\n')
}
