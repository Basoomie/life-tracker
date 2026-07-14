// v2 §9.5.2 — Reviews view Playwright tests. Named after the spec rules they
// verify (§CLAUDE.md). API is mocked via page.route(); no live backend, no live
// LLM/PubMed network needed.

import { test, expect, type Page } from '@playwright/test'
import type { Review, Recommendation } from '@tracker/shared'

function makeRecommendation(o: Partial<Recommendation> & { recommendation: string }): Recommendation {
  return {
    mechanism: 'Associative learning between cue and action.',
    sourceIdentifier: '23211256',
    sourceIdentifierType: 'pmid',
    evidenceQuality: 'mechanistic_plausibility_only',
    confidence: 'medium',
    groundedJustification: 'The source states habits form through repeated cue-action pairing.',
    targetedMetricFactId: null,
    targetedMetricLabel: null,
    ...o,
  }
}

function makeReview(o: Partial<Review> & { id: string }): Review {
  return {
    userId: 'u1',
    cadence: 'weekly',
    window: { startDay: '2026-07-01', endDay: '2026-07-07' },
    generatedAt: new Date(),
    narrative: '',
    recommendations: [],
    feedForwardOut: [],
    prose:
      '# Weekly review — 2026-07-01 to 2026-07-07\n\n' +
      '## Facts\n- Workout: 5 of 7 due days completed\n\n' +
      '## Recommendations\nNo good evidence for what to do here this period.',
    ...o,
  }
}

async function setupReviewMocks(page: Page, reviews: Review[]) {
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
  await page.route(/\/api\/preferences\/theme$/, (route) => route.fulfill({ json: { ok: true } }))
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/buckets', (route) => route.fulfill({ json: [] }))
  await page.route(/\/api\/reviews(\?.*)?$/, (route) => route.fulfill({ json: reviews }))
}

async function gotoReviews(page: Page) {
  await page.goto('/')
  await page.getByTestId('view-nav-reviews').click()
  await expect(page.getByTestId('reviews-view')).toBeVisible()
}

test.describe('v2 §9.5.2 Reviews view', () => {

  test('§9.4 item 6 — a zero-recommendation review renders as complete and honest, not broken or empty', async ({ page }) => {
    const review = makeReview({ id: 'rev-1', recommendations: [] })
    await setupReviewMocks(page, [review])
    await gotoReviews(page)

    const card = page.getByTestId('review-rev-1')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('review-rev-1-no-recs')).toBeVisible()
    await expect(card.getByTestId('review-rev-1-no-recs')).toContainText('complete, honest result')
    await expect(card.locator('[role="alert"]')).toHaveCount(0)
  })

  test('§9.4/§9.5.2 evidence quality is shown honestly — mechanistic_plausibility_only is never styled like a meta-analysis', async ({ page }) => {
    const weakRec = makeRecommendation({
      recommendation: 'Anchor Japanese immersion to a fixed morning slot.',
      evidenceQuality: 'mechanistic_plausibility_only',
    })
    const strongRec = makeRecommendation({
      recommendation: 'Reduce friction for the workout habit (lay out clothes the night before).',
      evidenceQuality: 'meta_analysis',
      sourceIdentifier: '10.1000/xyz',
      sourceIdentifierType: 'doi',
    })
    const review = makeReview({ id: 'rev-2', recommendations: [weakRec, strongRec] })
    await setupReviewMocks(page, [review])
    await gotoReviews(page)

    const cards = page.getByTestId('review-rev-2-recommendations').getByTestId('recommendation-card')
    await expect(cards).toHaveCount(2)

    const weakBadge = cards.nth(0).getByTestId('recommendation-evidence-quality')
    await expect(weakBadge).toHaveText('Mechanistic plausibility only')
    await expect(weakBadge).toHaveClass(/recommendation-card__quality-badge--weak/)

    const strongBadge = cards.nth(1).getByTestId('recommendation-evidence-quality')
    await expect(strongBadge).toHaveText('Meta-analysis')
    await expect(strongBadge).not.toHaveClass(/recommendation-card__quality-badge--weak/)

    await expect(cards.nth(1).getByTestId('recommendation-source-link'))
      .toHaveAttribute('href', 'https://doi.org/10.1000/xyz')
  })

  test('a recommendation links to its source (PMID resolves to PubMed)', async ({ page }) => {
    const rec = makeRecommendation({ recommendation: 'Test recommendation', sourceIdentifier: '23211256', sourceIdentifierType: 'pmid' })
    const review = makeReview({ id: 'rev-3', recommendations: [rec] })
    await setupReviewMocks(page, [review])
    await gotoReviews(page)

    await expect(page.getByTestId('recommendation-source-link'))
      .toHaveAttribute('href', 'https://pubmed.ncbi.nlm.nih.gov/23211256/')
  })

  test('§5.4/CLAUDE.md rule 6 — no rendered review string references a broken streak or a single missed day', async ({ page }) => {
    const review = makeReview({
      id: 'rev-4',
      prose:
        '# Weekly review — 2026-07-01 to 2026-07-07\n\n' +
        '## Facts\n- Meditation: current streak 0, longest streak 12\n\n' +
        '## Recommendations\nNo good evidence for what to do here this period.',
    })
    await setupReviewMocks(page, [review])
    await gotoReviews(page)

    const bodyText = await page.locator('body').innerText()
    const forbidden = [
      /broke.{0,20}streak/i,
      /broken.{0,20}streak/i,
      /don.?t break the chain/i,
      /you missed yesterday/i,
    ]
    for (const pattern of forbidden) {
      expect(bodyText).not.toMatch(pattern)
    }
  })

  test('§9.5.2 chronological list of past reviews is retained and readable', async ({ page }) => {
    const older = makeReview({ id: 'rev-old', window: { startDay: '2026-06-01', endDay: '2026-06-07' } })
    const newer = makeReview({ id: 'rev-new', window: { startDay: '2026-07-01', endDay: '2026-07-07' } })
    await setupReviewMocks(page, [newer, older]) // API returns newest-first
    await gotoReviews(page)

    await expect(page.getByTestId('review-list')).toBeVisible()
    await expect(page.getByTestId('review-rev-old')).toBeVisible()
    await expect(page.getByTestId('review-rev-new')).toBeVisible()
  })

  test('§9.5.2 empty state when no reviews exist yet', async ({ page }) => {
    await setupReviewMocks(page, [])
    await gotoReviews(page)
    await expect(page.getByTestId('reviews-empty')).toBeVisible()
  })

  test('light/dark and mobile-width usability', async ({ page }) => {
    const review = makeReview({ id: 'rev-5', recommendations: [makeRecommendation({ recommendation: 'Test' })] })
    await setupReviewMocks(page, [review])
    await page.setViewportSize({ width: 375, height: 812 })
    await gotoReviews(page)
    await expect(page.getByTestId('reviews-view')).toBeVisible()

    await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('reviews-view')).toBeVisible()
  })
})
