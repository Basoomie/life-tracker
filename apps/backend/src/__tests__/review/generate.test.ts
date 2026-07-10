// v2 §6 / §9.2 / §9.5.2 / §9.6 Category 4 — generate.ts integration tests.
// Hits a real database. The LLM is ALWAYS mocked — zero live network calls, per
// §CLAUDE.md's anti-flake rule and §9.6 Category 4's "no live model calls in CI".

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { generateReview } from '../../review/generate'
import { proposeEvidenceEntry, approveEvidenceEntry, archiveEvidenceEntryWithEvent } from '../../evidence/pipeline'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { completeLeaf } from '../../domain/completion'
import type { ReviewLLMClient } from '../../review/llm-client'
import type { Item } from '@tracker/shared'
import type { PubmedClientDeps } from '../../evidence/pubmed-client'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeDailyHabit(userId: string, name = 'Workout') {
  return repos.insertItem(getTestPool(), { userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned' })
}

async function materialize(item: Item, day: string, userId: string) {
  return ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
}

function verifiableDeps(): PubmedClientDeps {
  return {
    fetchImpl: (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('esummary.fcgi')) {
        return new Response(JSON.stringify({
          result: { uids: ['23211256'], '23211256': { title: 'Making health habitual', fulljournalname: 'Br J Gen Pract', pubdate: '2012 Dec', pubtype: ['Journal Article'] } },
        }), { status: 200 })
      }
      if (url.includes('efetch.fcgi')) {
        return new Response('<PubmedArticleSet><PubmedArticle><Abstract><AbstractText>Test abstract.</AbstractText></Abstract></PubmedArticle></PubmedArticleSet>', { status: 200 })
      }
      return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 })
    }) as unknown as typeof fetch,
  }
}

async function makeApprovedEvidence(userId: string, claim = 'Repetition in a stable context builds automaticity') {
  const entry = await proposeEvidenceEntry(
    getTestPool(), userId,
    {
      claim, mechanism: 'context-dependent habit formation', sourceIdentifierType: 'pmid',
      sourceIdentifier: '23211256', claimedEvidenceQuality: 'mechanistic_plausibility_only',
      groundedJustification: 'Automaticity develops through repetition in a stable context.',
    },
    'seeded', verifiableDeps()
  )
  return approveEvidenceEntry(getTestPool(), userId, entry.id, true)
}

function mockClient(toolInput: unknown): ReviewLLMClient {
  return { messages: { create: async () => ({ content: [{ type: 'tool_use', input: toolInput }] }) } }
}

const WINDOW_1 = { startDay: '2026-01-01', endDay: '2026-01-07' }
const WINDOW_2 = { startDay: '2026-01-08', endDay: '2026-01-14' }

describe('§9.5.2 — reviews are stored and retrievable', () => {
  it('a generated review persists facts, narrative, and verified recommendations, and is retrievable by id', async () => {
    const pool = getTestPool()
    const u = await makeUser('review-store@test.com')
    const item = await makeDailyHabit(u.id)
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      const occ = await materialize(item, day, u.id)
      await completeLeaf(pool, occ, u.id)
    }
    const evidence = await makeApprovedEvidence(u.id)

    const llm = mockClient({
      narrative: 'Adherence is on track this week.',
      recommendations: [{
        evidenceEntryId: evidence.id, recommendationText: 'Keep the workout at a fixed time',
        confidence: 'medium', targetedMetricFactId: `adherence:${item.id}`,
      }],
    })

    const stored = await generateReview(pool, u.id, 'weekly', WINDOW_1, { llm: { client: llm } })

    expect(stored.narrative).toBe('Adherence is on track this week.')
    expect(stored.recommendations).toHaveLength(1)
    expect(stored.recommendations[0].sourceIdentifier).toBe('23211256')
    expect(stored.prose).toContain('Keep the workout at a fixed time')

    const fetched = await repos.findReviewById(pool, stored.id, u.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.narrative).toBe(stored.narrative)

    const list = await repos.findReviewsByUser(pool, u.id, 'weekly')
    expect(list.map((r) => r.id)).toContain(stored.id)
  })

  it('logs a review_generated event with the recommendation count', async () => {
    const pool = getTestPool()
    const u = await makeUser('review-event@test.com')
    const stored = await generateReview(pool, u.id, 'weekly', WINDOW_1, { llm: { client: mockClient({ narrative: '', recommendations: [] }) } })

    const events = await repos.findConfigEvents(pool, u.id, 'review_generated')
    const forThisReview = events.filter((e) => (e.payload as { reviewId?: string }).reviewId === stored.id)
    expect(forThisReview).toHaveLength(1)
    expect((forThisReview[0].payload as { recommendationCount: number }).recommendationCount).toBe(0)
  })
})

describe('§13.4 — reviews are strictly user_id-scoped', () => {
  it('one user cannot retrieve another user\'s review by id', async () => {
    const pool = getTestPool()
    const u1 = await makeUser('review-scope-1@test.com')
    const u2 = await makeUser('review-scope-2@test.com')
    const stored = await generateReview(pool, u1.id, 'weekly', WINDOW_1, { llm: { client: mockClient({ narrative: '', recommendations: [] }) } })

    const asOther = await repos.findReviewById(pool, stored.id, u2.id)
    expect(asOther).toBeNull()
  })
})

describe('§CLAUDE.md / §9.4.1 — a past review\'s citation resolves even after the evidence entry is later archived', () => {
  it('recommendation fields are copied at generation time, so archiving the evidence afterward does not change the stored review', async () => {
    const pool = getTestPool()
    const u = await makeUser('review-archive-resolve@test.com')
    const evidence = await makeApprovedEvidence(u.id, 'Claim to be archived later')

    const llm = mockClient({
      narrative: '',
      recommendations: [{ evidenceEntryId: evidence.id, recommendationText: 'A suggestion', confidence: 'low', targetedMetricFactId: null }],
    })
    const stored = await generateReview(pool, u.id, 'weekly', WINDOW_1, { llm: { client: llm } })
    expect(stored.recommendations).toHaveLength(1)

    await archiveEvidenceEntryWithEvent(pool, u.id, evidence.id)

    const fetched = await repos.findReviewById(pool, stored.id, u.id)
    expect(fetched!.recommendations).toHaveLength(1)
    expect(fetched!.recommendations[0].sourceIdentifier).toBe('23211256')
    expect(fetched!.recommendations[0].mechanism).toBe('context-dependent habit formation')
  })
})

describe('a duplicate (cadence, window) pair for the same user is rejected — prevents double-generation', () => {
  it('inserting the same cadence/window twice violates the unique constraint', async () => {
    const pool = getTestPool()
    const u = await makeUser('review-dup@test.com')
    await generateReview(pool, u.id, 'weekly', WINDOW_1, { llm: { client: mockClient({ narrative: '', recommendations: [] }) } })
    await expect(
      generateReview(pool, u.id, 'weekly', WINDOW_1, { llm: { client: mockClient({ narrative: '', recommendations: [] }) } })
    ).rejects.toThrow()
  })
})

describe('§CLAUDE.md determinism — identical mocked LLM input yields identical stored output', () => {
  it('two users with identical fixtures and the same mocked response produce equal narratives and recommendations', async () => {
    const pool = getTestPool()
    const u1 = await makeUser('review-determinism-1@test.com')
    const u2 = await makeUser('review-determinism-2@test.com')
    const e1 = await makeApprovedEvidence(u1.id)
    const e2 = await makeApprovedEvidence(u2.id)

    const r1 = await generateReview(pool, u1.id, 'weekly', WINDOW_1, {
      llm: { client: mockClient({ narrative: 'steady', recommendations: [{ evidenceEntryId: e1.id, recommendationText: 'x', confidence: 'low', targetedMetricFactId: null }] }) },
    })
    const r2 = await generateReview(pool, u2.id, 'weekly', WINDOW_1, {
      llm: { client: mockClient({ narrative: 'steady', recommendations: [{ evidenceEntryId: e2.id, recommendationText: 'x', confidence: 'low', targetedMetricFactId: null }] }) },
    })

    expect(r1.narrative).toBe(r2.narrative)
    expect(r1.recommendations[0].recommendation).toBe(r2.recommendations[0].recommendation)
  })
})

describe('§9.2.1 — feed-forward carries across sequential reviews of the same cadence', () => {
  it('a recommendation repeated in the next week\'s review increments timesRecommended and keeps the original baseline', async () => {
    const pool = getTestPool()
    const u = await makeUser('review-feedforward@test.com')
    const item = await makeDailyHabit(u.id, 'Meditation')
    const evidence = await makeApprovedEvidence(u.id)
    const factId = `adherence:${item.id}`

    // Week 1: 2 of 4 due days completed (50%)
    for (const day of ['2026-01-01', '2026-01-02']) {
      const occ = await materialize(item, day, u.id)
      await completeLeaf(pool, occ, u.id)
    }
    for (const day of ['2026-01-03', '2026-01-04']) {
      await materialize(item, day, u.id) // left incomplete
    }

    const week1 = await generateReview(pool, u.id, 'weekly', WINDOW_1, {
      llm: { client: mockClient({ narrative: '', recommendations: [{ evidenceEntryId: evidence.id, recommendationText: 'Anchor it to mornings', confidence: 'medium', targetedMetricFactId: factId }] }) },
    })
    expect(week1.feedForwardOut).toHaveLength(1)
    expect(week1.feedForwardOut[0].timesRecommended).toBe(1)
    const baselineThen = week1.feedForwardOut[0].metricValueThen

    // Week 2: still nothing improves (same completion pattern) — metric stays put
    const week2 = await generateReview(pool, u.id, 'weekly', WINDOW_2, {
      llm: { client: mockClient({ narrative: '', recommendations: [{ evidenceEntryId: evidence.id, recommendationText: 'Anchor it to mornings', confidence: 'medium', targetedMetricFactId: factId }] }) },
    })

    expect(week2.feedForwardOut).toHaveLength(1)
    expect(week2.feedForwardOut[0].timesRecommended).toBe(2)
    expect(week2.feedForwardOut[0].metricValueThen).toBe(baselineThen)
  })
})
