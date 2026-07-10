// v2 §9.4 item 4 — "The claimed evidence_quality must match the source's actual
// publication type... derived from the record, not trusted from the entry."
//
// Pure function: PubMed publication-type tags in, our five-tier scale out.
// Zero I/O, zero DB access — the same "pure function over plain data" discipline
// as the stats primitives (§9.1.1), so it can be tested with known-answer fixtures.

import type { EvidenceQuality } from '@tracker/shared'

// Tier priority, highest first. A record can carry multiple pubtype tags at once
// (e.g. ["Journal Article","Meta-Analysis","Systematic Review"]); the highest tier
// present wins, matching how these tags are actually used in practice (a
// meta-analysis IS a systematic review, and PubMed tags it with both).
//
// "Journal Article" alone (no tag below it also present) and thin categories like
// Review/Case Reports/Editorial/Comment/Letter fall to the weakest tier — the honest
// call per CLAUDE.md v2 rule 8: never assert more than the record supports.
const TIER_TAGS: Array<{ tier: EvidenceQuality; tags: string[] }> = [
  { tier: 'meta_analysis', tags: ['Meta-Analysis'] },
  { tier: 'systematic_review', tags: ['Systematic Review'] },
  { tier: 'rct', tags: ['Randomized Controlled Trial', 'Controlled Clinical Trial'] },
  {
    tier: 'observational',
    tags: ['Observational Study', 'Comparative Study', 'Multicenter Study', 'Cohort Study'],
  },
]

export function derivePublicationTypeTier(publicationTypes: string[]): EvidenceQuality {
  for (const { tier, tags } of TIER_TAGS) {
    if (publicationTypes.some((t) => tags.includes(t))) return tier
  }
  return 'mechanistic_plausibility_only'
}
