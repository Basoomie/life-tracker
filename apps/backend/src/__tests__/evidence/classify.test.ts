// v2 §9.4 item 4 — "The claimed evidence_quality must match the source's actual
// publication type... derived from the record, not trusted from the entry."
// Pure function; known-answer fixtures using real PubMed pubtype tag combinations.

import { describe, it, expect } from 'vitest'
import { derivePublicationTypeTier } from '../../evidence/classify'

describe('§9.4 item 4 — derivePublicationTypeTier derives the tier from PubMed pubtype tags', () => {
  it('classifies a Meta-Analysis-tagged record as meta_analysis', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Meta-Analysis', 'Systematic Review'])).toBe('meta_analysis')
  })

  it('meta_analysis wins over systematic_review when both tags are present (a meta-analysis IS a systematic review)', () => {
    expect(derivePublicationTypeTier(['Systematic Review', 'Meta-Analysis'])).toBe('meta_analysis')
  })

  it('classifies a Systematic-Review-only record as systematic_review', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Systematic Review'])).toBe('systematic_review')
  })

  it('classifies a Randomized Controlled Trial record as rct', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Randomized Controlled Trial'])).toBe('rct')
  })

  it('classifies a Controlled Clinical Trial record as rct', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Controlled Clinical Trial'])).toBe('rct')
  })

  it('classifies an Observational Study record as observational', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Observational Study'])).toBe('observational')
  })

  it('classifies a Cohort Study record as observational', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Cohort Study'])).toBe('observational')
  })

  it('classifies a bare "Journal Article" record (no stronger tag) as mechanistic_plausibility_only', () => {
    expect(derivePublicationTypeTier(['Journal Article'])).toBe('mechanistic_plausibility_only')
  })

  it('classifies a Case Reports record as mechanistic_plausibility_only', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Case Reports'])).toBe('mechanistic_plausibility_only')
  })

  it('classifies a non-systematic Review record as mechanistic_plausibility_only (not a systematic review)', () => {
    expect(derivePublicationTypeTier(['Journal Article', 'Review'])).toBe('mechanistic_plausibility_only')
  })

  it('classifies an empty pubtype array as mechanistic_plausibility_only', () => {
    expect(derivePublicationTypeTier([])).toBe('mechanistic_plausibility_only')
  })

  it('a higher tier wins regardless of array order', () => {
    expect(derivePublicationTypeTier(['Case Reports', 'Meta-Analysis', 'Journal Article'])).toBe('meta_analysis')
  })
})
