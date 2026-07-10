// v2 §CLAUDE.md v2 rule 1 / §9.6 Category 4 — the prompt builder's structural isolation.
// "Structurally incapable" means: no import path exists from this file to the event log,
// occurrences, raw items, DB, or domain layer — not merely "instructed not to use them".

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { buildPrompt, REVIEW_TOOL_NAME } from '../../review/prompt-builder'
import type { PromptInput } from '../../review/types'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-07' }

describe('§CLAUDE.md v2 rule 1 — prompt builder has no import path to the event log or DB', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../review/prompt-builder.ts'), 'utf8')
  const importLines = src.split('\n').filter((l) => l.trimStart().startsWith('import'))

  it('imports nothing from db, repos, domain, or stats', () => {
    for (const line of importLines) {
      expect(line, `import line should not reference db: "${line}"`).not.toMatch(/\/db['"/]/)
      expect(line, `import line should not reference repos: "${line}"`).not.toMatch(/repos/)
      expect(line, `import line should not reference domain: "${line}"`).not.toMatch(/\/domain\//)
      expect(line, `import line should not reference stats: "${line}"`).not.toMatch(/\/stats\//)
      expect(line, `import line should not reference pg: "${line}"`).not.toMatch(/^import.*['"]pg['"]/)
    }
  })

  it('only imports from ./types and @tracker/shared', () => {
    for (const line of importLines) {
      expect(line).toMatch(/from ['"](\.\/types|@tracker\/shared)['"]/)
    }
  })
})

describe('§2 / §9.6 Category 4 — a "not yet" fact is never rendered as an asserted result', () => {
  it('cleared vs not_yet facts render distinctly, and not_yet never carries a power/p-value/effect-size figure', () => {
    const input: PromptInput = {
      cadence: 'weekly',
      window: WINDOW,
      facts: [
        {
          kind: 'layer2_not_yet', factId: 'context_stability:item1', itemId: 'item1',
          label: 'Japanese immersion — context stability', insight: 'context_stability',
          reason: 'need more sessions', nObserved: 2, nNeeded: 10,
        },
        {
          kind: 'layer2_cleared', factId: 'trajectory:item2', itemId: 'item2',
          label: 'Workout — trajectory', insight: 'trajectory', estimator: 'regression',
          summary: 'Workout: adherence is rising by 4.2 points/month (p=0.012, R²=0.61)',
          metricValue: 0.9, power: 0.85, pValue: 0.012, minimumDetectableEffect: 0.3,
          dataQualityNote: '95% disposition coverage',
        },
      ],
      evidence: [],
      feedForward: [],
    }

    const built = buildPrompt(input)

    expect(built.userMessage).toContain('not yet')
    expect(built.userMessage).toContain('need more sessions')
    expect(built.userMessage).toContain('have 2, need 10')

    expect(built.userMessage).toContain('p=0.012')
    expect(built.userMessage).toContain('power=0.85')

    // The not_yet line must never contain a p-value or power figure — there is none to
    // render (types.ts gives ReleasedLayer2NotYet no such field).
    const notYetLine = built.userMessage.split('\n').find((l) => l.includes('context_stability:item1'))!
    expect(notYetLine).not.toMatch(/p=/)
    expect(notYetLine).not.toMatch(/power=/)
  })
})

describe('§9.4 evidence rendering — only the closed evidence list is ever citable', () => {
  it('renders each evidence entry by its id so the model can only cite ids it was given', () => {
    const input: PromptInput = {
      cadence: 'monthly',
      window: WINDOW,
      facts: [],
      evidence: [
        { id: 'ev-1', claim: 'Repetition in a stable context builds automaticity', mechanism: 'context-dependent habit formation',
          sourceIdentifier: '23211256', sourceIdentifierType: 'pmid', evidenceQuality: 'observational',
          groundedJustification: 'Found automaticity increases with repetition in a constant context.' },
      ],
      feedForward: [],
    }
    const built = buildPrompt(input)
    expect(built.userMessage).toContain('id="ev-1"')
    expect(built.inputSchema).toMatchObject({ required: ['narrative', 'recommendations'] })
  })

  it('zero evidence entries is rendered honestly, not hidden', () => {
    const built = buildPrompt({ cadence: 'weekly', window: WINDOW, facts: [], evidence: [], feedForward: [] })
    expect(built.userMessage).toContain('no approved evidence entries exist yet')
  })
})

describe('§9.2.1 — feed-forward renders as a structured record, never past prose', () => {
  it('renders recommendation/metric/delta/timesRecommended, and there is no field to carry old narrative text', () => {
    const input: PromptInput = {
      cadence: 'weekly',
      window: WINDOW,
      facts: [],
      evidence: [],
      feedForward: [{
        factId: 'context_stability:item1', label: 'Japanese immersion — context stability',
        sourceIdentifier: '23211256', recommendation: 'Anchor it to mornings',
        timesRecommended: 12, metricValueThen: 0.1, metricValueNow: 0.11, delta: 0.01,
      }],
    }
    const built = buildPrompt(input)
    expect(built.userMessage).toContain('Anchor it to mornings')
    expect(built.userMessage).toContain('12x')
    expect(built.userMessage).toMatch(/delta \+?0\.01/)
    // FeedForwardRecord (packages/shared/src/types/review.ts) has no prose/narrative
    // field at all — there is nothing for buildPrompt to even accidentally forward.
  })
})

describe('§9.2 stance instructions are present in the system prompt', () => {
  it('instructs the model never to act, never to comment on a single miss, and to treat empty recommendations as valid', () => {
    const built = buildPrompt({ cadence: 'weekly', window: WINDOW, facts: [], evidence: [], feedForward: [] })
    expect(built.system).toMatch(/never suggest moving|never.*reschedul/i)
    expect(built.system).toMatch(/single missed day|broken streak/i)
    expect(built.system).toMatch(/empty recommendations array is a correct/i)
    expect(REVIEW_TOOL_NAME.length).toBeGreaterThan(0)
  })
})
