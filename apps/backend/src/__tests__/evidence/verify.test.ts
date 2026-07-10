// v2 §9.4 / §9.4.1 — The verification gate, tested adversarially.
//
// "Write the verification gate as if the proposer were adversarial... A gate that
// only catches malformed garbage is not a gate." Every test here simulates a
// candidate designed to slip past a weak gate, plus network-failure resilience.
//
// The external API is fully mocked (an injected fetchImpl) — zero live network,
// zero flakiness, deterministic per CLAUDE.md's anti-flake rule.

import { describe, it, expect, vi } from 'vitest'
import { verifyCandidate } from '../../evidence/verify'
import type { EvidenceCandidate } from '@tracker/shared'
import type { PubmedClientDeps } from '../../evidence/pubmed-client'

function baseCandidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    claim: 'Test claim',
    mechanism: 'Test mechanism',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification: 'Test justification',
    ...overrides,
  }
}

// Builds a mock fetchImpl that inspects the request URL and dispatches to
// esearch/esummary canned responses. Mirrors the real NCBI E-utilities shapes,
// captured live against the actual API while building this gate.
function mockFetch(opts: {
  esearchIdlist?: string[]
  esummaryUid?: string
  esummaryPubtype?: string[]
  esummaryTitle?: string
  esummaryJournal?: string
  esummaryPubdate?: string
  esummaryError?: boolean
  networkErrorOn?: 'esearch' | 'esummary' | 'efetch' | 'both'
  httpStatus?: number
  efetchXml?: string       // raw efetch response body (used for the abstract fetch)
  efetchHttpStatus?: number
}) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)

    if (url.includes('esearch.fcgi')) {
      if (opts.networkErrorOn === 'esearch' || opts.networkErrorOn === 'both') {
        throw new Error('simulated network failure')
      }
      return new Response(
        JSON.stringify({ esearchresult: { idlist: opts.esearchIdlist ?? [] } }),
        { status: opts.httpStatus ?? 200 }
      )
    }

    if (url.includes('esummary.fcgi')) {
      if (opts.networkErrorOn === 'esummary' || opts.networkErrorOn === 'both') {
        throw new Error('simulated network failure')
      }
      const uid = opts.esummaryUid
      if (!uid) {
        return new Response(JSON.stringify({ result: { uids: [] } }), { status: opts.httpStatus ?? 200 })
      }
      const doc = opts.esummaryError
        ? { uid, error: 'cannot get document summary' }
        : {
            uid,
            title: opts.esummaryTitle ?? 'A Test Article',
            fulljournalname: opts.esummaryJournal ?? 'Journal of Testing',
            pubdate: opts.esummaryPubdate ?? '2012 Dec',
            pubtype: opts.esummaryPubtype ?? ['Journal Article'],
          }
      return new Response(
        JSON.stringify({ result: { uids: [uid], [uid]: doc } }),
        { status: opts.httpStatus ?? 200 }
      )
    }

    if (url.includes('efetch.fcgi')) {
      if (opts.networkErrorOn === 'efetch' || opts.networkErrorOn === 'both') {
        throw new Error('simulated network failure')
      }
      return new Response(opts.efetchXml ?? '<PubmedArticleSet></PubmedArticleSet>', {
        status: opts.efetchHttpStatus ?? 200,
      })
    }

    throw new Error(`unexpected URL in test: ${url}`)
  }) as unknown as typeof fetch
}

// The REAL efetch XML for PMID 21056605, captured live against the actual NCBI API
// while building this gate — a known-answer fixture, not a hand-rolled guess at the shape.
const REAL_ADRIAANSE_EFETCH_XML = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">21056605</PMID><Article PubModel="Print-Electronic"><Journal><Title>Appetite</Title></Journal><ArticleTitle>Do implementation intentions help to eat a healthy diet? A systematic review and meta-analysis of the empirical evidence.</ArticleTitle><Abstract><AbstractText Label="OBJECTIVE">This systematic review and meta-analysis examined whether implementation intentions are an effective tool to help people put their intentions to eat a healthy diet into practice. Additionally, it was investigated whether the quality of the outcome measures and the quality of the control conditions that are used in these studies influence implementation intentions' effectiveness.</AbstractText><AbstractText Label="METHODS">Twenty three empirical studies investigating the effect of implementation intentions on eating behavior were included. In assessing the empirical evidence, a distinction was made between studies that aim to increase healthy eating (i.e., eating more fruits) and studies that aim to diminish unhealthy eating (i.e., eating fewer unhealthy snacks).</AbstractText><AbstractText Label="RESULTS">Implementation intentions are an effective tool for promoting the inclusion of healthy food items in one's diet (Cohen's d=.51), but results for diminishing unhealthy eating patterns are less strong (Cohen's d=.29). For studies aiming to increase healthy eating, it was found that higher quality outcome measures and lower quality control conditions tended to yield stronger effects.</AbstractText><AbstractText Label="CONCLUSION">Implementation intentions are somewhat more effective in promoting healthy eating than in diminishing unhealthy eating, although for some studies promoting healthy eating effect sizes may have been inflated due to less than optimal control conditions.</AbstractText><CopyrightInformation>Copyright © 2010 Elsevier Ltd. All rights reserved.</CopyrightInformation></Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`

// ── Malformed identifiers — rejected before any network call ────────────────────

describe('§9.4 verification gate — malformed identifiers are rejected without a network call', () => {
  it('rejects a non-numeric PMID', async () => {
    const fetchImpl = mockFetch({})
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: 'not-a-pmid' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('malformed_identifier')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a DOI missing the required 10.XXXX/ prefix', async () => {
    const fetchImpl = mockFetch({})
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'doi', sourceIdentifier: 'not-a-doi' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('malformed_identifier')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ── The core adversarial cases from the task spec ────────────────────────────────

describe('§9.4 — a well-formed but fabricated PMID is REJECTED (not just malformed garbage)', () => {
  it('rejects a realistic-looking PMID that does not resolve on PubMed', async () => {
    const fetchImpl = mockFetch({ esummaryUid: undefined }) // esummary returns no uids at all
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '99999999' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('identifier_not_found')
  })

  it('rejects a PMID that PubMed itself reports an error for (realistic non-existent-uid shape)', async () => {
    const fetchImpl = mockFetch({ esummaryUid: '999999999', esummaryError: true })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '999999999' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('identifier_not_found')
  })
})

describe('§9.4 — a real PMID with a falsely-claimed evidence_quality is REJECTED', () => {
  it('rejects a real case report claimed as a meta-analysis; actual type is derived from the record', async () => {
    const fetchImpl = mockFetch({
      esummaryUid: '23211256',
      esummaryPubtype: ['Journal Article', 'Case Reports'],
    })
    const result = await verifyCandidate(
      baseCandidate({
        sourceIdentifierType: 'pmid',
        sourceIdentifier: '23211256',
        claimedEvidenceQuality: 'meta_analysis',
      }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('evidence_quality_mismatch')
    // The actual (derived) tier travels with the rejection — not the claimed one.
    expect(result.status === 'rejected' && result.actualEvidenceQuality).toBe('mechanistic_plausibility_only')
  })
})

describe('§9.4 — a real identifier with a truthfully-claimed type passes verification', () => {
  it('verifies a real PMID whose actual PubMed tags match the claimed tier', async () => {
    const fetchImpl = mockFetch({
      esummaryUid: '21056605',
      esummaryPubtype: ['Journal Article', 'Meta-Analysis', 'Systematic Review'],
      esummaryTitle: 'Do implementation intentions help to eat a healthy diet?',
      esummaryJournal: 'Appetite',
      esummaryPubdate: '2011 Feb',
    })
    const result = await verifyCandidate(
      baseCandidate({
        sourceIdentifierType: 'pmid',
        sourceIdentifier: '21056605',
        claimedEvidenceQuality: 'meta_analysis',
      }),
      { fetchImpl }
    )
    expect(result.status).toBe('verified')
    expect(result.status === 'verified' && result.resolved.pmid).toBe('21056605')
    expect(result.status === 'verified' && result.resolved.year).toBe(2011)
    expect(result.status === 'verified' && result.actualEvidenceQuality).toBe('meta_analysis')
  })

  it('resolves a DOI through PubMed to the same PMID and verifies identically', async () => {
    const fetchImpl = mockFetch({
      esearchIdlist: ['21056605'],
      esummaryUid: '21056605',
      esummaryPubtype: ['Journal Article', 'Meta-Analysis', 'Systematic Review'],
    })
    const result = await verifyCandidate(
      baseCandidate({
        sourceIdentifierType: 'doi',
        sourceIdentifier: '10.1016/j.appet.2010.10.012',
        claimedEvidenceQuality: 'meta_analysis',
      }),
      { fetchImpl }
    )
    expect(result.status).toBe('verified')
    expect(result.status === 'verified' && result.resolved.pmid).toBe('21056605')
  })
})

describe('§9.4 item 2 — a disallowed / unindexed source is REJECTED (denylist by construction)', () => {
  it('rejects a DOI that does not resolve to any PubMed-indexed record (e.g. a blog post DOI)', async () => {
    const fetchImpl = mockFetch({ esearchIdlist: [] })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'doi', sourceIdentifier: '10.5555/blogpost.123' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('identifier_not_found')
  })
})

// ── Network resilience — never fail open ─────────────────────────────────────────

describe('§9.4 — network failure does not fail open', () => {
  it('a PMID esummary timeout/error results in rejection, never verification', async () => {
    const fetchImpl = mockFetch({ networkErrorOn: 'esummary' })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '23211256' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('network_error')
  })

  it('a DOI esearch timeout/error results in rejection, never verification', async () => {
    const fetchImpl = mockFetch({ networkErrorOn: 'esearch' })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'doi', sourceIdentifier: '10.1016/j.appet.2010.10.012' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('network_error')
  })

  it('a non-2xx HTTP response is treated as a network error, not a clean not-found', async () => {
    const fetchImpl = mockFetch({ esummaryUid: undefined, httpStatus: 503 })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '23211256' }),
      { fetchImpl }
    )
    expect(result.status).toBe('rejected')
    expect(result.status === 'rejected' && result.reason).toBe('network_error')
  })
})

// ── Determinism ────────────────────────────────────────────────────────────────

describe('§9.4 — verification is deterministic given the same mocked responses', () => {
  it('running the same candidate against the same mock twice yields the same result', async () => {
    const opts = {
      esummaryUid: '23211256',
      esummaryPubtype: ['Journal Article'],
    }
    const candidate = baseCandidate({ sourceIdentifier: '23211256', claimedEvidenceQuality: 'mechanistic_plausibility_only' })
    const r1 = await verifyCandidate(candidate, { fetchImpl: mockFetch(opts) })
    const r2 = await verifyCandidate(candidate, { fetchImpl: mockFetch(opts) })
    expect(r1.status).toBe('verified')
    expect(r2.status).toBe('verified')
  })
})

// ── §9.4.2 — the abstract is what makes the human review step real ──────────────
//
// Verification cannot catch a misrepresented finding (a real PMID + a real
// meta-analysis + a garbled description of it passes every mechanical check). A bare
// title/journal/year does not give the human reviewer anything to catch it WITH either
// — a self-consistent but subtly wrong number in grounded_justification reads exactly
// as confident as a correct one. These tests assert the plumbing that closes that gap:
// the actual abstract text reaches the verified result, using the REAL structured
// abstract for the Adriaanse meta-analysis as a known-answer fixture.

describe('§9.4.2 — a verified result carries the actual abstract for the human to check claims against', () => {
  it('extracts structured abstract sections (OBJECTIVE/METHODS/RESULTS/CONCLUSION) with their reported numbers intact', async () => {
    const fetchImpl = mockFetch({
      esummaryUid: '21056605',
      esummaryPubtype: ['Journal Article', 'Meta-Analysis', 'Systematic Review'],
      efetchXml: REAL_ADRIAANSE_EFETCH_XML,
    })
    const result = await verifyCandidate(
      baseCandidate({
        sourceIdentifierType: 'pmid',
        sourceIdentifier: '21056605',
        claimedEvidenceQuality: 'meta_analysis',
      }),
      { fetchImpl }
    )
    expect(result.status).toBe('verified')
    const abstract = result.status === 'verified' ? result.resolved.abstract : null
    expect(abstract).toContain('OBJECTIVE:')
    expect(abstract).toContain('RESULTS:')
    expect(abstract).toContain('CONCLUSION:')
    // The exact numbers a grounded_justification claim must be checked against —
    // this is precisely what a swapped-number misrepresentation would be caught by.
    expect(abstract).toContain("d=.51")
    expect(abstract).toContain("d=.29")
    expect(abstract).toContain('promoting the inclusion of healthy food items')
    expect(abstract).toContain('diminishing unhealthy eating patterns are less strong')
  })

  it('a fetch failure while retrieving the abstract does NOT block verification (non-fatal, but the field is honestly null)', async () => {
    const fetchImpl = mockFetch({
      esummaryUid: '23211256',
      esummaryPubtype: ['Journal Article'],
      networkErrorOn: 'efetch',
    })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '23211256' }),
      { fetchImpl }
    )
    expect(result.status).toBe('verified')
    expect(result.status === 'verified' && result.resolved.abstract).toBeNull()
  })

  it('a record with no structured abstract sections resolves to a null abstract, not an empty string', async () => {
    const fetchImpl = mockFetch({
      esummaryUid: '23211256',
      esummaryPubtype: ['Journal Article'],
      efetchXml: '<PubmedArticleSet><PubmedArticle></PubmedArticle></PubmedArticleSet>',
    })
    const result = await verifyCandidate(
      baseCandidate({ sourceIdentifierType: 'pmid', sourceIdentifier: '23211256' }),
      { fetchImpl }
    )
    expect(result.status).toBe('verified')
    expect(result.status === 'verified' && result.resolved.abstract).toBeNull()
  })
})
