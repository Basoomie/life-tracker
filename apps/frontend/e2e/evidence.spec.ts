// v2 §9.4.1 "Approval UI (minimal)" — Evidence approval view Playwright tests.
// Named after the spec rules they verify (§CLAUDE.md).
//
// API is mocked via page.route(); no live backend, no live PubMed network needed.

import { test, expect, type Page } from '@playwright/test'
import type { EvidenceEntry } from '@tracker/shared'

function makeEntry(o: Partial<EvidenceEntry> & { id: string; claim: string }): EvidenceEntry {
  return {
    userId: 'u1',
    mechanism: 'Test mechanism',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification: 'The source states X.',
    provenance: 'seeded',
    proposedAt: new Date(),
    verificationStatus: 'verified',
    verifiedAt: new Date(),
    rejectionReason: null,
    rejectionDetail: null,
    resolvedPmid: '23211256',
    resolvedTitle: 'Making health habitual',
    resolvedJournal: 'Br J Gen Pract',
    resolvedYear: 2012,
    resolvedPublicationTypes: ['Journal Article'],
    resolvedAbstract: 'RESULTS: the source reports X in full.',
    actualEvidenceQuality: 'mechanistic_plausibility_only',
    approvalStatus: 'pending',
    approvedAt: null,
    abstractVisibleAtApproval: null,
    archivedAt: null,
    createdAt: new Date(),
    ...o,
  }
}

type MockState = { entries: EvidenceEntry[]; lastApproveBody: { abstractVisible?: boolean } | null }

async function setupMocks(page: Page, entries: EvidenceEntry[]): Promise<MockState> {
  const state: MockState = { entries, lastApproveBody: null }

  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/buckets', (route) => route.fulfill({ json: [] }))

  await page.route('/api/evidence/pending-approval', (route) => {
    route.fulfill({ json: state.entries })
  })

  await page.route(/\/api\/evidence\/[^/]+\/approve$/, (route) => {
    const id = route.request().url().match(/\/evidence\/([^/]+)\/approve$/)?.[1]
    const entry = state.entries.find((e) => e.id === id)
    if (!entry) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    state.lastApproveBody = JSON.parse(route.request().postData() ?? '{}')
    const updated = { ...entry, approvalStatus: 'approved' as const, approvedAt: new Date() }
    state.entries = state.entries.filter((e) => e.id !== id)
    route.fulfill({ json: updated })
  })

  await page.route(/\/api\/evidence\/[^/]+\/reject$/, (route) => {
    const id = route.request().url().match(/\/evidence\/([^/]+)\/reject$/)?.[1]
    const entry = state.entries.find((e) => e.id === id)
    if (!entry) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    const updated = { ...entry, approvalStatus: 'rejected' as const, approvedAt: new Date() }
    state.entries = state.entries.filter((e) => e.id !== id)
    route.fulfill({ json: updated })
  })

  return state
}

async function gotoEvidence(page: Page) {
  await page.goto('/')
  await page.getByTestId('view-nav-evidence').click()
  await expect(page.getByTestId('evidence-view')).toBeVisible()
}

test.describe('§9.4.1 Evidence approval — minimal UI', () => {

  test('§9.4.1 shows verified entries awaiting approval with claim, mechanism, justification, and resolved source', async ({ page }) => {
    const entry = makeEntry({
      id: 'ev-1',
      claim: 'Anchoring a habit to a consistent cue speeds automatic performance.',
      mechanism: 'Associative learning between cue and action.',
      groundedJustification: 'The article states habits are triggered by contextual cues.',
    })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-1')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Anchoring a habit to a consistent cue')
    await expect(card).toContainText('Associative learning between cue and action')
    await expect(card).toContainText('The article states habits are triggered by contextual cues')
    await expect(card).toContainText('Making health habitual')
    await expect(card).toContainText('Br J Gen Pract')
  })

  test('§9.4.1 follow-up — the abstract panel is EXPANDED BY DEFAULT (nudge, not gate) so the claim can be checked against the source without extra clicks', async ({ page }) => {
    const entry = makeEntry({
      id: 'ev-abstract',
      claim: 'Claim to check',
      resolvedAbstract: 'RESULTS: the effect size was d=.51 for the primary outcome.',
    })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-abstract')
    // Open by default — visible without any user action.
    await expect(card.getByTestId('evidence-entry-ev-abstract-abstract')).toBeVisible()
    await expect(card.getByTestId('evidence-entry-ev-abstract-abstract')).toContainText('d=.51')

    // A direct link to the source itself — the fallback when the abstract isn't enough.
    await expect(card.getByTestId('evidence-entry-ev-abstract-pubmed-link')).toHaveAttribute(
      'href', 'https://pubmed.ncbi.nlm.nih.gov/23211256/'
    )
  })

  test('§9.4.1 follow-up — the reviewer can actively collapse the abstract panel (a nudge, not a lock)', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-collapse', claim: 'Claim', resolvedAbstract: 'RESULTS: some finding.' })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-collapse')
    await expect(card.getByTestId('evidence-entry-ev-collapse-abstract')).toBeVisible()

    await card.locator('summary').click()
    await expect(card.getByTestId('evidence-entry-ev-collapse-abstract')).not.toBeVisible()
  })

  test('§9.4.2 a missing abstract is surfaced honestly, not silently hidden — reviewer is told to verify on PubMed', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-no-abstract', claim: 'Claim with no fetched abstract', resolvedAbstract: null })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-no-abstract')
    await expect(card.getByTestId('evidence-entry-ev-no-abstract-abstract-missing')).toBeVisible()
    await expect(card.getByTestId('evidence-entry-ev-no-abstract-abstract-missing')).toContainText('verify')
    await expect(card.getByTestId('evidence-entry-ev-no-abstract-abstract')).toHaveCount(0)
  })

  test('§9.4.1 follow-up — approval is NOT blocked with the abstract panel collapsed (the absence of a gate is the behavior under test)', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-collapsed-approve', claim: 'Claim', resolvedAbstract: 'RESULTS: some finding.' })
    const state = await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-collapsed-approve')
    await card.locator('summary').click()   // collapse it
    await expect(card.getByTestId('evidence-entry-ev-collapsed-approve-abstract')).not.toBeVisible()

    await card.getByTestId('evidence-entry-ev-collapsed-approve-approve').click()
    await expect(card).not.toBeVisible()   // approval succeeded — no block, no warning dialog
    expect(state.lastApproveBody).toEqual({ abstractVisible: false })
  })

  test('§9.4.1 follow-up — approval is NOT blocked when no abstract was ever resolved', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-no-abstract-approve', claim: 'Claim', resolvedAbstract: null })
    const state = await setupMocks(page, [entry])
    await gotoEvidence(page)

    const card = page.getByTestId('evidence-entry-ev-no-abstract-approve')
    await card.getByTestId('evidence-entry-ev-no-abstract-approve-approve').click()
    await expect(card).not.toBeVisible()
    // Panel never existed, so nothing was "visible" — the server is authoritative about
    // "no_abstract" regardless of what the client reports here (see pipeline.test.ts).
    expect(state.lastApproveBody).toEqual({ abstractVisible: false })
  })

  test('§9.4.1 follow-up — approving with the abstract left open (the default) reports it as visible', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-open-approve', claim: 'Claim', resolvedAbstract: 'RESULTS: some finding.' })
    const state = await setupMocks(page, [entry])
    await gotoEvidence(page)

    await page.getByTestId('evidence-entry-ev-open-approve-approve').click()
    expect(state.lastApproveBody).toEqual({ abstractVisible: true })
  })

  test('§9.4.1 empty state is shown when nothing is awaiting approval', async ({ page }) => {
    await setupMocks(page, [])
    await gotoEvidence(page)
    await expect(page.getByTestId('evidence-empty')).toBeVisible()
  })

  test('§9.4.1 step 3 — approving an entry removes it from the pending list', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-approve', claim: 'Claim to approve' })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    await expect(page.getByTestId('evidence-entry-ev-approve')).toBeVisible()
    await page.getByTestId('evidence-entry-ev-approve-approve').click()
    await expect(page.getByTestId('evidence-entry-ev-approve')).not.toBeVisible()
    await expect(page.getByTestId('evidence-empty')).toBeVisible()
  })

  test('§9.4.1 step 3 — rejecting an entry removes it from the pending list', async ({ page }) => {
    const entry = makeEntry({ id: 'ev-reject', claim: 'Claim to reject' })
    await setupMocks(page, [entry])
    await gotoEvidence(page)

    await expect(page.getByTestId('evidence-entry-ev-reject')).toBeVisible()
    await page.getByTestId('evidence-entry-ev-reject-reject').click()
    await expect(page.getByTestId('evidence-entry-ev-reject')).not.toBeVisible()
    await expect(page.getByTestId('evidence-empty')).toBeVisible()
  })

  test('§9.4.1 — approving one entry does not affect another entry in the list', async ({ page }) => {
    const entryA = makeEntry({ id: 'ev-a', claim: 'Claim A' })
    const entryB = makeEntry({ id: 'ev-b', claim: 'Claim B' })
    await setupMocks(page, [entryA, entryB])
    await gotoEvidence(page)

    await page.getByTestId('evidence-entry-ev-a-approve').click()
    await expect(page.getByTestId('evidence-entry-ev-a')).not.toBeVisible()
    await expect(page.getByTestId('evidence-entry-ev-b')).toBeVisible()
  })

})
