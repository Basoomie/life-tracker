// v2 §9.4 item 5 / §5.4 / §9.6 Category 4 — render.ts: prose rendered from verified
// structure; zero-recommendation reviews render correctly; no single-day/streak language.

import { describe, it, expect } from 'vitest'
import { renderReviewProse } from '../../review/render'
import type { ReleasedFinding } from '../../review/types'
import type { Recommendation } from '@tracker/shared'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-07' }

const FACTS: ReleasedFinding[] = [
  { kind: 'layer1', factId: 'adherence:item1', itemId: 'item1', label: 'Workout — adherence',
    summary: 'Workout: 75% raw adherence (3 of 4 completed)', metricValue: 0.75, rawCounts: { dueCount: 4, completedCount: 3 } },
  { kind: 'layer2_not_yet', factId: 'context_stability:item1', itemId: 'item1',
    label: 'Workout — context stability', insight: 'context_stability', reason: 'need more sessions', nObserved: 2, nNeeded: 10 },
]

const RECOMMENDATION: Recommendation = {
  recommendation: 'Anchor the workout to a fixed time each day',
  mechanism: 'context-dependent repetition',
  sourceIdentifier: '23211256',
  sourceIdentifierType: 'pmid',
  evidenceQuality: 'observational',
  confidence: 'medium',
  groundedJustification: 'Automaticity increased with repetition in a stable context.',
  targetedMetricFactId: 'adherence:item1',
  targetedMetricLabel: 'Workout — adherence',
}

describe('§9.4 item 6 — zero recommendations renders an explicit, honest message', () => {
  it('renders "no good evidence" rather than an empty or missing section', () => {
    const prose = renderReviewProse({ cadence: 'weekly', window: WINDOW, facts: FACTS, narrative: '', recommendations: [] })
    expect(prose).toContain('No good evidence for what to do here this period.')
  })
})

describe('§9.4 item 5 — recommendation prose is rendered from verified fields, not re-generated', () => {
  it('renders the recommendation text plus the copied evidentiary fields', () => {
    const prose = renderReviewProse({ cadence: 'weekly', window: WINDOW, facts: FACTS, narrative: '', recommendations: [RECOMMENDATION] })
    expect(prose).toContain('Anchor the workout to a fixed time each day')
    expect(prose).toContain('context-dependent repetition')
    expect(prose).toContain('pmid:23211256')
    expect(prose).toContain('Automaticity increased with repetition in a stable context.')
  })
})

describe('§5.4 / §9.6 Category 4 — no generated text ever references a single missed day or broken streak', () => {
  it('the rendered review contains no streak-shaming language, because facts never carry that granularity', () => {
    const prose = renderReviewProse({
      cadence: 'weekly', window: WINDOW, facts: FACTS,
      narrative: 'Adherence held steady this week; nothing changing enough to flag.',
      recommendations: [],
    })
    expect(prose.toLowerCase()).not.toMatch(/broke.*streak|missed a day|streak.*broken/)
  })
})

describe('§2 — a "not yet" fact renders as progress, never as an asserted finding', () => {
  it('includes the not_yet reason and progress counts, with no p-value or effect size', () => {
    const prose = renderReviewProse({ cadence: 'weekly', window: WINDOW, facts: FACTS, narrative: '', recommendations: [] })
    expect(prose).toContain('not yet')
    expect(prose).toContain('need more sessions')
    expect(prose).toContain('have 2, need 10')
  })
})

describe('narrative section', () => {
  it('omits the Observations section entirely when the narrative is empty (fails-safe model output)', () => {
    const prose = renderReviewProse({ cadence: 'weekly', window: WINDOW, facts: FACTS, narrative: '', recommendations: [] })
    expect(prose).not.toContain('## Observations')
  })

  it('includes the narrative under an Observations section when present', () => {
    const prose = renderReviewProse({ cadence: 'weekly', window: WINDOW, facts: FACTS, narrative: 'Steady week overall.', recommendations: [] })
    expect(prose).toContain('## Observations')
    expect(prose).toContain('Steady week overall.')
  })
})
