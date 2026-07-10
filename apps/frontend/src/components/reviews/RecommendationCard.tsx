// v2 §9.4/§9.5.2 — a recommendation's evidence quality must be shown honestly:
// several seeded levers legitimately carry `mechanistic_plausibility_only`, and
// that must never be styled to look like settled science. Links to its source
// (PMID/DOI, already resolved and verified in step 3a).

import type { Recommendation, EvidenceQuality } from '@tracker/shared'

const QUALITY_LABELS: Record<EvidenceQuality, string> = {
  meta_analysis: 'Meta-analysis',
  systematic_review: 'Systematic review',
  rct: 'Randomized controlled trial',
  observational: 'Observational study',
  mechanistic_plausibility_only: 'Mechanistic plausibility only',
}

// Only the strongest tiers get the confident badge treatment; everything weaker
// (observational, mechanistic-only) is visually muted so it reads as what it is.
const STRONG_TIERS = new Set<EvidenceQuality>(['meta_analysis', 'systematic_review', 'rct'])

type Props = { recommendation: Recommendation }

export function RecommendationCard({ recommendation: r }: Props) {
  const strong = STRONG_TIERS.has(r.evidenceQuality)
  const href = r.sourceIdentifierType === 'pmid'
    ? `https://pubmed.ncbi.nlm.nih.gov/${r.sourceIdentifier}/`
    : `https://doi.org/${r.sourceIdentifier}`

  return (
    <div className="recommendation-card" data-testid="recommendation-card">
      <div className="recommendation-card__header">
        <span
          className={`recommendation-card__quality-badge${strong ? '' : ' recommendation-card__quality-badge--weak'}`}
          data-testid="recommendation-evidence-quality"
        >
          {QUALITY_LABELS[r.evidenceQuality]}
        </span>
        <span className="recommendation-card__confidence">Confidence: {r.confidence}</span>
      </div>

      <p className="recommendation-card__text">{r.recommendation}</p>
      <p className="recommendation-card__mechanism"><strong>Mechanism:</strong> {r.mechanism}</p>
      <p className="recommendation-card__justification"><strong>Source reports:</strong> {r.groundedJustification}</p>

      {r.targetedMetricLabel && (
        <p className="recommendation-card__target">Targets: {r.targetedMetricLabel}</p>
      )}

      <a
        className="recommendation-card__source-link"
        href={href}
        target="_blank"
        rel="noreferrer"
        data-testid="recommendation-source-link"
      >
        View source ↗
      </a>
    </div>
  )
}
